/**
 * GET /api/verify-payment?bookingId=BK-xxx
 *
 * Called after Yoco redirects back to the site on success.
 * Queries Yoco for the checkout status, confirms the booking in Redis,
 * upgrades slot keys to permanent, and sends confirmation emails.
 */

import { kv } from './_kv.js';

const BREVO_API_URL   = 'https://api.brevo.com/v3/smtp/email';
const YOCO_CHECKOUT_URL = 'https://payments.yoco.com/api/checkouts';

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day (5hrs)', fullday: 'Full day (10hrs)' };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function sendEmails(booking) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('[verify-payment] BREVO_API_KEY is not set — confirmation emails skipped');
    return;
  }
  const from      = process.env.FROM_EMAIL   || 'hello@shootstudios.co.za';
  const adminEmail = process.env.ADMIN_EMAIL || 'hello@shootstudios.co.za';
  const studios  = booking.studios.map(s => STUDIO_NAMES[s] || s).join(' + ');
  const durLabel = DUR_LABELS[booking.duration] || booking.duration;
  const extraLbl = booking.extraHours > 0 ? ` + ${booking.extraHours} extra hr(s)` : '';
  const paidStr  = `R${(booking.amountCents / 100).toFixed(2)}`;
  const dateStr  = new Date(booking.date + 'T12:00:00').toLocaleDateString('en-ZA', {
    weekday: 'long', day: 'numeric', month: 'long', year: 'numeric',
  });

  const clientHtml = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:48px 24px 64px;">
<table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0" border="0">
<tr><td>
  <p style="margin:0 0 40px;font-size:10px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;color:rgba(255,255,255,0.3);">SHOOT. Photographic Studios</p>
  <h1 style="margin:0 0 16px;font-size:38px;font-weight:900;font-style:italic;color:#fff;line-height:1;letter-spacing:-1.5px;">Booking Confirmed.</h1>
  <p style="margin:0 0 40px;font-size:15px;line-height:1.75;color:rgba(255,255,255,0.55);">Your payment has been received and your session is locked in. See you at the studio!</p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(255,255,255,0.12);margin-bottom:40px;">
    <tr><td style="padding:20px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Booking Reference</p>
      <p style="margin:0;font-size:20px;font-weight:900;letter-spacing:3px;color:#fff;">${booking.bookingId}</p>
    </td></tr>
    <tr><td style="padding:20px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Studio</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${studios}</p>
    </td></tr>
    <tr><td style="padding:20px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Date &amp; Time</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${dateStr} at ${booking.time}</p>
    </td></tr>
    <tr><td style="padding:20px 28px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Duration</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${durLabel}${extraLbl}</p>
    </td></tr>
    <tr><td style="padding:20px 28px;">
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Amount Paid</p>
      <p style="margin:0;font-size:22px;font-weight:900;color:#fff;">${paidStr}</p>
    </td></tr>
  </table>
  <p style="margin:0;font-size:12px;line-height:1.7;color:rgba(255,255,255,0.35);">
    Need to make changes? Contact us at
    <a href="mailto:hello@shootstudios.co.za" style="color:rgba(255,255,255,0.6);">hello@shootstudios.co.za</a>
    or <a href="tel:+27609948107" style="color:rgba(255,255,255,0.6);">060 994 8107</a>.
  </p>
  <p style="margin:48px 0 0;font-size:10px;color:rgba(255,255,255,0.18);">SHOOT. Photographic Studios · 135 Albert Rd, Woodstock, Cape Town</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const studioNote =
    `CONFIRMED BOOKING\n${'='.repeat(40)}\n\n` +
    `Ref:      ${booking.bookingId}\n` +
    `Client:   ${booking.firstName} ${booking.lastName}\n` +
    `Email:    ${booking.email}\n` +
    `Phone:    ${booking.phone}\n\n` +
    `Studio:   ${studios}\n` +
    `Date:     ${booking.date} at ${booking.time}\n` +
    `Duration: ${durLabel}${extraLbl}\n\n` +
    `Amount:   ${paidStr}\n` +
    `Txn:      ${booking.transactionId || '—'}\n` +
    `Status:   CONFIRMED (paid)`;

  const post = async p => {
    try {
      const r = await fetch(BREVO_API_URL, {
        method:  'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify(p),
      });
      if (!r.ok) {
        const body = await r.text();
        console.error('[verify-payment] Brevo error', r.status, body);
      }
    } catch (e) {
      console.error('[verify-payment] email fetch failed:', e.message);
    }
  };

  await post({
    sender:      { name: 'SHOOT. Studios', email: from },
    to:          [{ email: booking.email, name: `${booking.firstName} ${booking.lastName}` }],
    subject:     `Booking Confirmed — ${booking.bookingId}`,
    htmlContent: clientHtml,
  });
  await post({
    sender:      { name: 'SHOOT. Bookings', email: from },
    to:          [{ email: adminEmail }],
    subject:     `[CONFIRMED] ${booking.bookingId} — ${studios} — ${booking.date} ${booking.time}`,
    textContent: studioNote,
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId } = req.query;
  if (!bookingId || !/^BK-/.test(bookingId)) {
    return res.status(400).json({ error: 'Invalid booking ID.' });
  }

  try {
    // ── Check if already confirmed (idempotent) ────────────────────────────────
    const existingJson = await kv('GET', `booking:record:${bookingId}`);
    if (existingJson) {
      const existing = JSON.parse(existingJson);
      if (existing.bookingStatus === 'confirmed') {
        return res.status(200).json({ success: true, bookingId, alreadyConfirmed: true });
      }
    }

    // ── Load pending booking ───────────────────────────────────────────────────
    const pendingJson = await kv('GET', `booking:pending:${bookingId}`);
    if (!pendingJson) {
      return res.status(404).json({
        error: 'Booking session expired or not found. Please contact us if you were charged.',
      });
    }
    const pending = JSON.parse(pendingJson);

    // ── Verify payment with Yoco server-side ──────────────────────────────────
    const checkoutId = pending.checkoutId;
    if (!checkoutId) {
      console.error(`[verify-payment] bookingId=${bookingId} has no checkoutId in pending record — cannot verify with Yoco`);
      return res.status(502).json({ error: 'Payment verification failed. Please contact us if you were charged.' });
    }

    const yocoRes = await fetch(`${YOCO_CHECKOUT_URL}/${checkoutId}`, {
      headers: { 'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}` },
    });

    if (!yocoRes.ok) {
      const body = await yocoRes.text();
      console.error(`[verify-payment] Yoco lookup failed status=${yocoRes.status} body=${body}`);
      return res.status(502).json({ error: 'Could not verify payment status. Please contact us if you were charged.' });
    }

    const checkout = await yocoRes.json();

    if (checkout.status !== 'complete') {
      console.warn(`[verify-payment] bookingId=${bookingId} Yoco status=${checkout.status} — not confirming`);
      return res.status(402).json({ error: `Payment not confirmed (status: ${checkout.status}). Please contact us if you were charged.` });
    }

    // Sanity-check: Yoco metadata must reference the same bookingId
    if (checkout.metadata?.bookingId && checkout.metadata.bookingId !== bookingId) {
      console.error(`[verify-payment] metadata mismatch: expected ${bookingId} got ${checkout.metadata.bookingId}`);
      return res.status(400).json({ error: 'Booking reference mismatch. Please contact us.' });
    }

    console.log(`[verify-payment] Yoco confirmed bookingId=${bookingId} checkoutId=${checkoutId} amount=${checkout.amount}`);

    const confirmed = {
      ...pending,
      paymentStatus: 'paid',
      bookingStatus: 'confirmed',
      confirmedAt:   new Date().toISOString(),
    };

    // Save permanent booking record (2-year TTL)
    await kv('SET', `booking:record:${bookingId}`, JSON.stringify(confirmed), 'EX', String(60 * 60 * 24 * 730));
    console.log(`[verify-payment] booking record saved bookingId=${bookingId}`);

    // Upgrade slot keys: remove TTL (make permanent)
    for (const studio of pending.studios) {
      await kv('SET', `booking:slot:${studio}:${pending.date}:${pending.time}`, bookingId);
    }

    // Promote interval from pending → confirmed in the intervals hash
    const startMins = pending.startMins ?? null;
    const endMins   = pending.endMins   ?? null;
    if (startMins !== null && endMins !== null) {
      for (const studio of pending.studios) {
        const hashKey = `booking:intervals:${studio}:${pending.date}`;
        await kv('HDEL', hashKey, `p:${bookingId}`);
        await kv('HSET', hashKey, `c:${bookingId}`, `${startMins}:${endMins}`);
      }
    }

    // Clean up pending state
    await kv('DEL', `booking:pending:${bookingId}`);

    // Send confirmation emails — must be awaited before returning or Vercel kills the function
    await sendEmails(confirmed);
    console.log(`[verify-payment] emails dispatched bookingId=${bookingId}`);

    return res.status(200).json({ success: true, bookingId });

  } catch (err) {
    console.error('[verify-payment]', err);
    return res.status(500).json({ error: 'Verification failed. Please contact us if you were charged.' });
  }
}
