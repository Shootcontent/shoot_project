/**
 * GET    /api/admin/quote?id=QT-xxx  — fetch quote
 * PATCH  /api/admin/quote?id=QT-xxx  — update notes/price
 * DELETE /api/admin/quote?id=QT-xxx  — cancel quote
 * POST   /api/admin/quote?id=QT-xxx&action=send-payment    — lock slots + send payment email
 * POST   /api/admin/quote?id=QT-xxx&action=resend-payment  — resend payment link
 * POST   /api/admin/quote?id=QT-xxx&action=cancel-payment  — cancel payment request
 */

import { requireSession } from '../_admin-auth.js';
import {
  getQuote, updateQuote, cancelQuote,
  lockQuoteSlots, unlockQuoteSlots,
  createPaymentRequest, getPaymentRequest, updatePaymentRequest,
  sendPaymentRequestEmail,
} from '../_admin-booking.js';
import { kv } from '../_kv.js';
import { auditLog } from '../_audit.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  const { id } = req.query;
  if (!id || !id.startsWith('QT-')) return res.status(400).json({ error: 'Invalid quote ID.' });

  // ── GET ───────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    const quote = await getQuote(id);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });
    return res.status(200).json({ quote });
  }

  // ── PATCH — update notes/price ────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    const quote = await getQuote(id);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });
    if (['confirmed','cancelled'].includes(quote.status))
      return res.status(400).json({ error: `Cannot edit a ${quote.status} quote.` });

    const allowed = ['notes', 'clientNotes', 'customPriceCents'];
    const updates = {};
    for (const k of allowed) {
      if (req.body[k] !== undefined) updates[k] = req.body[k];
    }
    try {
      const updated = await updateQuote(id, updates);
      auditLog(session.username, 'quote.update', 'quote', id, updates);
      return res.status(200).json({ quote: updated });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── DELETE — cancel ───────────────────────────────────────────────────────────
  if (req.method === 'DELETE') {
    try {
      await cancelQuote(id);
      auditLog(session.username, 'quote.cancel', 'quote', id, {});
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(err.message === 'Quote not found.' ? 404 : 500).json({ error: err.message });
    }
  }

  // ── POST — actions ────────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const { action } = req.query;
    const quote = await getQuote(id);
    if (!quote) return res.status(404).json({ error: 'Quote not found.' });

    const proto = req.headers['x-forwarded-proto'] || 'http';
    const host  = req.headers.host;

    // ── send-payment ────────────────────────────────────────────────────────────
    if (action === 'send-payment') {
      if (['confirmed','cancelled'].includes(quote.status))
        return res.status(400).json({ error: `Cannot send payment for a ${quote.status} quote.` });

      try {
        // Cancel existing pending payment request if any
        if (quote.paymentToken) {
          await updatePaymentRequest(quote.paymentToken, { status: 'cancelled' });
          if (quote.slotsLocked) await unlockQuoteSlots(quote);
          await updateQuote(id, { slotsLocked: false, paymentToken: null });
        }

        // Lock slots
        await lockQuoteSlots(quote);

        // Create payment request
        const expiresInHours = parseInt(req.body?.expiresInHours, 10) || 48;
        const payReq = await createPaymentRequest({
          quoteId: id,
          amountCents: quote.customPriceCents,
          expiresInHours,
          createdBy: session.username,
        });

        // Send email
        await sendPaymentRequestEmail({
          quote, token: payReq.token,
          amountCents: payReq.amountCents,
          expiresAt: payReq.expiresAt,
          proto, host,
        });

        // Update request as emailed
        await updatePaymentRequest(payReq.token, { emailedAt: new Date().toISOString() });

        // Update quote
        await updateQuote(id, { status: 'pending_payment', paymentToken: payReq.token, slotsLocked: true });
        await kv('SADD', 'booking:idx:pending-payment', id);
        await kv('SREM', 'booking:idx:drafts', id);

        auditLog(session.username, 'quote.send-payment', 'quote', id, { email: quote.email, expiresInHours });
        return res.status(200).json({ ok: true, token: payReq.token });
      } catch (err) {
        console.error('[quote send-payment]', err);
        return res.status(500).json({ error: err.message });
      }
    }

    // ── resend-payment ──────────────────────────────────────────────────────────
    if (action === 'resend-payment') {
      if (quote.status !== 'pending_payment' || !quote.paymentToken)
        return res.status(400).json({ error: 'No active payment request to resend.' });
      try {
        const payReq = await getPaymentRequest(quote.paymentToken);
        if (!payReq || payReq.status === 'expired')
          return res.status(400).json({ error: 'Payment request expired. Use send-payment to issue a new one.' });

        await sendPaymentRequestEmail({
          quote, token: payReq.token,
          amountCents: payReq.amountCents,
          expiresAt: payReq.expiresAt,
          proto, host,
        });
        await updatePaymentRequest(payReq.token, { emailedAt: new Date().toISOString() });
        auditLog(session.username, 'quote.resend-payment', 'quote', id, { email: quote.email });
        return res.status(200).json({ ok: true });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    // ── cancel-payment ──────────────────────────────────────────────────────────
    if (action === 'cancel-payment') {
      if (!quote.paymentToken)
        return res.status(400).json({ error: 'No active payment request.' });
      try {
        await updatePaymentRequest(quote.paymentToken, { status: 'cancelled' });
        if (quote.slotsLocked) await unlockQuoteSlots(quote);
        const updatedQuote = await updateQuote(id, { status: 'draft', slotsLocked: false, paymentToken: null });
        await kv('SREM', 'booking:idx:pending-payment', id);
        await kv('SADD', 'booking:idx:drafts', id);
        auditLog(session.username, 'quote.cancel-payment', 'quote', id, {});
        return res.status(200).json({ ok: true, quote: updatedQuote });
      } catch (err) {
        return res.status(500).json({ error: err.message });
      }
    }

    return res.status(400).json({ error: `Unknown action: ${action}` });
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
