// api/_email.js — Resend email helper (underscore = not a Vercel route)

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = { '90min':'90 minutes','2hrs':'2 hours','3hrs':'3 hours','halfday':'Half day (5hrs)','fullday':'Full day (10hrs)' };

async function sendConfirmationEmail(booking) {
  if (!process.env.RESEND_API_KEY) {
    console.warn('[email] RESEND_API_KEY not set — skipping confirmation email');
    return;
  }

  const studioNames = (booking.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + ');
  const durLabel    = DUR_LABELS[booking.durationKey] || booking.durationKey;
  const dateStr     = booking.date
    ? new Date(booking.date + 'T12:00').toLocaleDateString('en-ZA', { weekday:'long', day:'numeric', month:'long', year:'numeric' })
    : booking.date;
  const totalRands  = booking.totalAmountCents ? `R${(booking.totalAmountCents / 100).toLocaleString('en-ZA')}` : `R${booking.totalAmount}`;

  const html = `<!DOCTYPE html>
<html>
<head><meta charset="UTF-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#f5f5f5;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
  <table width="100%" cellpadding="0" cellspacing="0" style="background:#f5f5f5;padding:40px 20px;">
    <tr><td align="center">
      <table width="560" cellpadding="0" cellspacing="0" style="max-width:560px;width:100%;">

        <!-- Header -->
        <tr><td style="background:#0a0a0a;border-radius:12px 12px 0 0;padding:32px 40px;text-align:center;">
          <p style="margin:0;font-size:22px;font-weight:900;font-style:italic;color:#ffffff;letter-spacing:-0.02em;">SHOOT. Studios</p>
          <p style="margin:6px 0 0;font-size:12px;color:rgba(255,255,255,0.45);letter-spacing:2px;text-transform:uppercase;">Cape Town</p>
        </td></tr>

        <!-- Green bar -->
        <tr><td style="background:#16a34a;padding:16px 40px;text-align:center;">
          <p style="margin:0;font-size:14px;font-weight:700;color:#ffffff;letter-spacing:0.5px;">✓ &nbsp; Booking Confirmed &nbsp; ✓</p>
        </td></tr>

        <!-- Body -->
        <tr><td style="background:#ffffff;padding:40px;">
          <p style="margin:0 0 8px;font-size:22px;font-weight:800;color:#0a0a0a;">Hi ${escHtml(booking.firstName)},</p>
          <p style="margin:0 0 32px;font-size:15px;color:#555;line-height:1.7;">Your studio session is confirmed and payment received. See you soon!</p>

          <!-- Booking details -->
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#f9f9f9;border-radius:10px;overflow:hidden;margin-bottom:28px;">
            ${row('Studio', studioNames)}
            ${row('Date', dateStr)}
            ${row('Start Time', booking.startTime || '—')}
            ${row('Duration', durLabel + (booking.extraHours > 0 ? ` + ${booking.extraHours} extra hr(s)` : ''))}
            ${booking.photoPackage && booking.photoPackage !== 'none' ? row('Photography', capitalize(booking.photoPackage) + ' Package') : ''}
            ${rowTotal('Amount Paid', totalRands)}
          </table>

          <!-- Test mode notice -->
          ${process.env.YOCO_SECRET_KEY?.startsWith('sk_test_') ? `
          <table width="100%" cellpadding="0" cellspacing="0" style="background:#fff3cd;border-radius:8px;margin-bottom:24px;">
            <tr><td style="padding:14px 18px;font-size:12px;color:#856404;">
              🧪 <strong>Test Booking</strong> — This is a sandbox payment. No real charge was made.
            </td></tr>
          </table>` : ''}

          <p style="margin:0 0 8px;font-size:14px;color:#333;line-height:1.7;">
            If you have any questions about your booking, reply to this email or reach us on WhatsApp.
          </p>

          <!-- CTA -->
          <table cellpadding="0" cellspacing="0" style="margin:28px 0 0;">
            <tr><td style="background:#0a0a0a;border-radius:6px;padding:14px 28px;text-align:center;">
              <a href="https://wa.me/27609948107" style="color:#ffffff;font-size:14px;font-weight:700;text-decoration:none;">WhatsApp Us</a>
            </td></tr>
          </table>
        </td></tr>

        <!-- Footer -->
        <tr><td style="background:#f0f0f0;border-radius:0 0 12px 12px;padding:20px 40px;text-align:center;">
          <p style="margin:0;font-size:12px;color:#999;">SHOOT. Studios CT &nbsp;·&nbsp; Cape Town, South Africa</p>
          <p style="margin:4px 0 0;font-size:12px;color:#bbb;">hello@shootstudios.co.za &nbsp;·&nbsp; 060 994 8107</p>
        </td></tr>

      </table>
    </td></tr>
  </table>
</body>
</html>`;

  try {
    const res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${process.env.RESEND_API_KEY}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from:    'SHOOT. Studios <bookings@shootstudios.co.za>',
        to:      [booking.email],
        subject: `Booking Confirmed — ${studioNames} on ${dateStr}`,
        html,
      }),
    });
    const data = await res.json();
    if (!res.ok) console.error('[email] Resend error:', data);
    else console.log('[email] Confirmation sent to', booking.email, '| id:', data.id);
  } catch (err) {
    console.error('[email] Failed to send:', err.message);
  }
}

function row(label, value) {
  if (!value) return '';
  return `<tr>
    <td style="padding:12px 18px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#888;border-bottom:1px solid #eee;width:40%;">${label}</td>
    <td style="padding:12px 18px;font-size:14px;font-weight:600;color:#111;border-bottom:1px solid #eee;">${escHtml(value)}</td>
  </tr>`;
}
function rowTotal(label, value) {
  return `<tr>
    <td style="padding:14px 18px;font-size:12px;font-weight:700;text-transform:uppercase;letter-spacing:0.08em;color:#888;">${label}</td>
    <td style="padding:14px 18px;font-size:20px;font-weight:900;color:#0a0a0a;">${escHtml(value)}</td>
  </tr>`;
}
function escHtml(s) { return String(s||'').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function capitalize(s) { return s ? s[0].toUpperCase() + s.slice(1) : s; }

module.exports = { sendConfirmationEmail };
