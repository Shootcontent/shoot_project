/**
 * GET /api/verify-admin-payment?token={token}&quoteId={quoteId}
 * PUBLIC endpoint — verifies Yoco payment for an admin-created booking and confirms it.
 *
 * Called after Yoco redirects the customer back to pay.html?status=paid.
 * Idempotent — safe to call multiple times.
 */

import { getPaymentRequest, getQuote, updatePaymentRequest, promoteQuoteToBooking } from './_admin-booking.js';
import { auditLog } from './_audit.js';
import { icsAttachment } from './_ics.js';

const OWNER_EMAILS = ['hello@shootstudios.co.za', 'elad@asapsolutions.co.za'];

const YOCO_CHECKOUT_URL = 'https://payments.yoco.com/api/checkouts';
const STUDIO_NAMES      = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS        = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day (5 hrs)', fullday: 'Full day (10 hrs)' };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'same-origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
}

async function sendConfirmationEmails(booking) {
  const apiKey = process.env.BREVO_API_KEY;
  const from   = process.env.FROM_EMAIL || 'hello@shootstudios.co.za';
  if (!apiKey) { console.warn('[verify-admin-payment] BREVO_API_KEY not set — skipping emails'); return; }

  const studios  = (booking.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + ');
  const durLabel = DUR_LABELS[booking.duration] || booking.duration;
  const paidStr  = `R${(booking.amountCents / 100).toFixed(0)}`;
  const dateStr  = new Date(booking.date + 'T12:00:00').toLocaleDateString('en-ZA', { weekday:'long', day:'numeric', month:'long', year:'numeric' });

  const clientHtml = `<!DOCTYPE html>
<html><head><meta charset="utf-8"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0"><tr><td align="center" style="padding:48px 24px 64px;">
<table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0"><tr><td>
<p style="margin:0 0 40px;font-size:10px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;color:rgba(255,255,255,0.3);">SHOOT. Photographic Studios</p>
<h1 style="margin:0 0 16px;font-size:38px;font-weight:900;font-style:italic;color:#fff;line-height:1;letter-spacing:-1.5px;">Booking Confirmed.</h1>
<p style="margin:0 0 40px;font-size:15px;line-height:1.75;color:rgba(255,255,255,0.55);">Your payment has been received and your session is locked in. See you at the studio!</p>
<table width="100%" cellpadding="0" cellspacing="0" style="border:1px solid rgba(255,255,255,0.12);margin-bottom:40px;">
  <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
    <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Booking Reference</p>
    <p style="margin:0;font-size:20px;font-weight:900;letter-spacing:3px;color:#fff;">${booking.bookingId}</p>
  </td></tr>
  <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
    <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Studio</p>
    <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${studios}</p>
  </td></tr>
  <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
    <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Date &amp; Time</p>
    <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${dateStr} at ${booking.time}</p>
  </td></tr>
  <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
    <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Duration</p>
    <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${durLabel}</p>
  </td></tr>
  <tr><td style="padding:18px 24px;">
    <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Amount Paid</p>
    <p style="margin:0;font-size:22px;font-weight:900;color:#fff;">${paidStr}</p>
  </td></tr>
</table>
${booking.clientNotes ? `<table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(255,255,255,0.08);background:rgba(255,255,255,0.03);margin-bottom:32px;">
  <tr><td style="padding:18px 24px;">
    <p style="margin:0 0 8px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">What's Included</p>
    <p style="margin:0;font-size:14px;line-height:1.7;color:rgba(255,255,255,0.75);">${booking.clientNotes.replace(/\n/g, '<br>')}</p>
  </td></tr>
</table>` : ''}
<p style="margin:0;font-size:12px;line-height:1.7;color:rgba(255,255,255,0.35);">
  Questions? <a href="mailto:hello@shootstudios.co.za" style="color:rgba(255,255,255,0.6);">hello@shootstudios.co.za</a> or <a href="tel:+27609948107" style="color:rgba(255,255,255,0.6);">060 994 8107</a>.
</p>
<p style="margin:48px 0 0;font-size:10px;color:rgba(255,255,255,0.18);">SHOOT. Photographic Studios &nbsp;·&nbsp; 135 Albert Rd, Woodstock, Cape Town</p>
</td></tr></table>
</td></tr></table>
</body></html>`;

  const post = p => fetch('https://api.brevo.com/v3/smtp/email', {
    method: 'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify(p),
  }).catch(e => console.error('[verify-admin-payment] email error:', e));

  const attachment = icsAttachment(booking);

  await post({
    sender:      { name: 'SHOOT. Studios', email: from },
    to:          [{ email: booking.email, name: `${booking.firstName} ${booking.lastName}` }],
    subject:     `Booking Confirmed — ${booking.bookingId}`,
    htmlContent: clientHtml,
    attachment,
  });

  await post({
    sender:      { name: 'SHOOT. Bookings', email: from },
    to:          OWNER_EMAILS.map(email => ({ email })),
    subject:     `[CONFIRMED] ${booking.bookingId} — ${studios} — ${booking.date} ${booking.time}`,
    textContent: `ADMIN BOOKING CONFIRMED\n${'='.repeat(40)}\nRef: ${booking.bookingId}\nClient: ${booking.firstName} ${booking.lastName}\nEmail: ${booking.email}\nStudio: ${studios}\nDate: ${booking.date} at ${booking.time}\nAmount: ${paidStr}\nSource: Admin Booking${booking.clientNotes ? '\n\nClient Notes:\n' + booking.clientNotes : ''}`,
    attachment,
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const { token, quoteId } = req.query;
  if (!token || !quoteId) return res.status(400).json({ error: 'token and quoteId required.' });

  try {
    // Idempotency: check if already confirmed
    const quote = await getQuote(quoteId);
    if (quote?.status === 'confirmed') {
      return res.status(200).json({ success: true, bookingId: quote.bookingId, alreadyConfirmed: true });
    }

    const payReq = await getPaymentRequest(token);
    if (!payReq) return res.status(404).json({ error: 'Payment request not found.' });
    if (payReq.status === 'expired')   return res.status(410).json({ error: 'Payment link expired.' });
    if (payReq.status === 'cancelled') return res.status(410).json({ error: 'Payment request was cancelled.' });
    if (!payReq.checkoutId)            return res.status(400).json({ error: 'Payment not initiated yet.' });

    // Verify with Yoco
    const yocoRes = await fetch(`${YOCO_CHECKOUT_URL}/${payReq.checkoutId}`, {
      headers: { 'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}` },
    });

    if (!yocoRes.ok) {
      return res.status(502).json({ error: 'Could not verify payment. Please contact us.' });
    }

    const checkout = await yocoRes.json();
    if (checkout.status !== 'completed') {
      return res.status(402).json({ error: `Payment not completed (status: ${checkout.status}).` });
    }

    if (!quote) return res.status(404).json({ error: 'Booking details not found.' });

    // Promote quote → confirmed booking
    const booking = await promoteQuoteToBooking(quote, {
      transactionId:    checkout.id,
      paidAmountCents:  checkout.amount || payReq.amountCents,
    });

    // Mark payment request as paid
    await updatePaymentRequest(token, { status: 'paid', paidAt: new Date().toISOString() });

    // Send emails
    await sendConfirmationEmails(booking);

    auditLog('system', 'payment.confirmed', 'quote', quoteId, { bookingId: booking.bookingId, amount: checkout.amount });

    return res.status(200).json({ success: true, bookingId: booking.bookingId });
  } catch (err) {
    console.error('[verify-admin-payment]', err);
    return res.status(500).json({ error: 'Verification failed. Please contact us if you were charged.' });
  }
}
