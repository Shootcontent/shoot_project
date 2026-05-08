// api/verify-payment.js — verifies Yoco payment and sends confirmation email via cPanel SMTP

const nodemailer = require('nodemailer');

const YOCO_API     = 'https://payments.yoco.com/api/checkouts';
const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = { '90min':'90 min','2hrs':'2 hours','3hrs':'3 hours','halfday':'Half day (5hrs)','fullday':'Full day (10hrs)' };

// Track which checkouts we've already emailed (in-memory, per function instance)
const emailed = new Set();

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { checkoutId } = req.query;
  if (!checkoutId) return res.status(400).json({ error: 'Missing checkoutId' });
  if (!process.env.YOCO_SECRET_KEY) return res.status(500).json({ error: 'Payment not configured — YOCO_SECRET_KEY missing' });

  // ── Query Yoco ───────────────────────────────────────────────────────────────
  let checkout;
  try {
    const r = await fetch(`${YOCO_API}/${checkoutId}`, {
      headers: { 'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}` },
    });
    if (!r.ok) return res.status(502).json({ error: 'Could not reach Yoco' });
    checkout = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Network error verifying payment' });
  }

  const status = (checkout.status || '').toLowerCase();
  console.log('[verify-payment] checkout:', checkoutId, '| status:', status);

  // ── Confirmed ────────────────────────────────────────────────────────────────
  if (status === 'complete' || status === 'completed' || status === 'succeeded' || status === 'paid') {
    // Send email once per checkout (guard against repeated polling)
    if (!emailed.has(checkoutId)) {
      emailed.add(checkoutId);
      sendConfirmationEmail(checkout).catch(err => console.error('[email] failed:', err.message));
    }
    return res.status(200).json({
      status:  'confirmed',
      booking: {
        checkoutId:  checkout.id,
        amountRands: ((checkout.amount || 0) / 100).toFixed(2),
      },
    });
  }

  if (status === 'failed')                            return res.status(200).json({ status: 'failed' });
  if (status === 'cancelled' || status === 'expired') return res.status(200).json({ status: 'cancelled' });

  return res.status(200).json({ status: 'pending' });
};

// ── Send confirmation email via cPanel SMTP ───────────────────────────────────
async function sendConfirmationEmail(checkout) {
  const smtpPass = process.env.SMTP_PASS;
  if (!smtpPass) { console.warn('[email] SMTP_PASS not set — skipping email'); return; }

  const meta       = checkout.metadata || {};
  const studios    = (meta.studios || '').split(',').filter(Boolean).map(s => STUDIO_NAMES[s] || s).join(' + ') || '—';
  const durLabel   = DUR_LABELS[meta.durationKey] || meta.durationKey || '—';
  const extraHrs   = Number(meta.extraHours || 0);
  const totalRands = meta.totalRands || ((checkout.amount || 0) / 100).toFixed(2);
  const dateStr    = meta.date
    ? new Date(meta.date + 'T12:00').toLocaleDateString('en-ZA', { weekday:'long', day:'numeric', month:'long', year:'numeric' })
    : '—';

  const transporter = nodemailer.createTransport({
    host:   process.env.SMTP_HOST || 'mail.shootstudios.co.za',
    port:   Number(process.env.SMTP_PORT || 587),
    secure: false,
    auth: {
      user: process.env.SMTP_USER || 'hello@shootstudios.co.za',
      pass: smtpPass,
    },
    tls: { rejectUnauthorized: false },
  });

  const customerName = `${meta.firstName || ''} ${meta.lastName || ''}`.trim() || 'there';

  const html = `<!DOCTYPE html>
<html><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" style="padding:40px 20px;background:#f5f5f5;">
<tr><td align="center">
<table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

  <tr><td style="background:#0a0a0a;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
    <p style="margin:0;font-size:24px;font-weight:900;font-style:italic;color:#fff;letter-spacing:-0.02em;">SHOOT. Studios</p>
    <p style="margin:6px 0 0;font-size:11px;color:rgba(255,255,255,0.4);letter-spacing:2px;text-transform:uppercase;">Cape Town</p>
  </td></tr>

  <tr><td style="background:#15803d;padding:14px 40px;text-align:center;">
    <p style="margin:0;font-size:13px;font-weight:700;color:#fff;letter-spacing:1px;">✓ &nbsp; BOOKING CONFIRMED &nbsp; ✓</p>
  </td></tr>

  <tr><td style="background:#ffffff;padding:40px;">
    <p style="margin:0 0 6px;font-size:22px;font-weight:800;color:#0a0a0a;">Hi ${customerName},</p>
    <p style="margin:0 0 32px;font-size:15px;color:#666;line-height:1.7;">Your studio session is confirmed and your payment has been received. We can't wait to shoot with you!</p>

    <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:10px;overflow:hidden;margin-bottom:28px;">
      <tr>
        <td style="padding:14px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#999;border-bottom:1px solid #eee;width:38%;">Studio</td>
        <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #eee;">${studios}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#999;border-bottom:1px solid #eee;">Date</td>
        <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #eee;">${dateStr}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#999;border-bottom:1px solid #eee;">Start Time</td>
        <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #eee;">${meta.startTime || '—'}</td>
      </tr>
      <tr>
        <td style="padding:14px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#999;border-bottom:1px solid #eee;">Duration</td>
        <td style="padding:14px 20px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #eee;">${durLabel}${extraHrs > 0 ? ` + ${extraHrs} extra hr(s)` : ''}</td>
      </tr>
      <tr>
        <td style="padding:16px 20px;font-size:11px;font-weight:700;letter-spacing:0.08em;text-transform:uppercase;color:#999;">Amount Paid</td>
        <td style="padding:16px 20px;font-size:22px;font-weight:900;color:#0a0a0a;">R${Number(totalRands).toLocaleString('en-ZA')}</td>
      </tr>
    </table>

    <p style="margin:0 0 28px;font-size:14px;color:#555;line-height:1.7;">
      Questions about your booking? Reply to this email or reach us on WhatsApp.
    </p>

    <table cellpadding="0" cellspacing="0">
      <tr><td style="background:#0a0a0a;border-radius:6px;">
        <a href="https://wa.me/27609948107" style="display:block;padding:14px 28px;color:#fff;font-size:14px;font-weight:700;text-decoration:none;">WhatsApp Us →</a>
      </td></tr>
    </table>
  </td></tr>

  <tr><td style="background:#f0f0f0;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
    <p style="margin:0;font-size:12px;color:#aaa;">SHOOT. Studios CT &nbsp;·&nbsp; Cape Town, South Africa</p>
    <p style="margin:4px 0 0;font-size:12px;color:#bbb;">hello@shootstudios.co.za &nbsp;·&nbsp; 060 994 8107</p>
  </td></tr>

</table>
</td></tr>
</table>
</body></html>`;

  // Send to customer
  await transporter.sendMail({
    from:    '"SHOOT. Studios" <hello@shootstudios.co.za>',
    to:      meta.email,
    subject: `Booking Confirmed — ${studios} on ${dateStr}`,
    html,
  });

  // Also notify the studio
  await transporter.sendMail({
    from:    '"SHOOT. Studios Bookings" <hello@shootstudios.co.za>',
    to:      'hello@shootstudios.co.za',
    subject: `New Booking: ${meta.firstName} ${meta.lastName} — ${studios} on ${dateStr}`,
    text: [
      `NEW CONFIRMED BOOKING`,
      ``,
      `Customer: ${meta.firstName} ${meta.lastName}`,
      `Email:    ${meta.email}`,
      `Phone:    ${meta.phone}`,
      ``,
      `Studio:   ${studios}`,
      `Date:     ${dateStr}`,
      `Time:     ${meta.startTime}`,
      `Duration: ${durLabel}${extraHrs > 0 ? ` + ${extraHrs} extra hr(s)` : ''}`,
      ``,
      `Amount Paid: R${Number(totalRands).toLocaleString('en-ZA')}`,
      `Yoco Checkout: ${checkout.id}`,
    ].join('\n'),
  });

  console.log('[email] Sent to', meta.email, 'and hello@shootstudios.co.za');
}
