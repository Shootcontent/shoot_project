/**
 * POST /api/create-booking
 *
 * Flow:
 * 1. Validate all input fields
 * 2. Server-side price recalculation (never trust client)
 * 3. Atomically reserve time slots (SET NX EX 900) — prevents double-booking
 * 4. Charge via Yoco API using the payment token from frontend popup
 * 5. On success: confirm slots permanently, persist booking record
 * 6. On failure: release reserved slots, return error
 * 7. Send confirmation emails via Brevo
 */

import { kv } from './_kv.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const YOCO_CHARGE_URL = 'https://online.yoco.com/v1/charges/';

const VALID_STUDIOS  = new Set(['curve', 'studio1', 'pool']);
const VALID_DURATIONS = new Set(['90min', '2hrs', '3hrs', 'halfday', 'fullday']);
const DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE         = /^\d{2}:\d{2}$/;
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Pricing tables — mirrors frontend BM.studioPrices
const STUDIO_PRICES = {
  curve:   { '90min': 550, '2hrs': 900,  '3hrs': 1350, halfday: 1750, fullday: 3300 },
  studio1: { '90min': 550, '2hrs': 700,  '3hrs': 1050, halfday: 1650, fullday: 3150 },
  pool:    { '90min': 850, '2hrs': 1100, '3hrs': 1650, halfday: 2650, fullday: 5300 },
};
const PHOTO_PRICES  = { basic: 1400, standard: 2500, premium: 10000 };
const ADDON_PRICES  = { sunset: 100, snoot: 80, mic: 100, rgb: 150 };
const CAMERA_PRICES = { rp: { halfday: 400, fullday: 800 }, r6: { halfday: 600, fullday: 1200 } };
const LENS_PRICES   = { '2470': { halfday: 350, fullday: 700 }, '50': { halfday: 250, fullday: 500 } };
const EXTRA_RATE    = 200;   // R200/hr per selected studio
const SURCHARGE_RATE = 200;  // R200/hr for after-hours / weekend / holiday
const AFTER_HOURS   = 17;    // 17:00

// Duration → decimal hours
const DURATION_HOURS = { '90min': 1.5, '2hrs': 2, '3hrs': 3, halfday: 5, fullday: 10 };

// Valid discount codes — mirrors validate-discount.js
const DISCOUNT_CODES = { SHOOT10: 10 };

// SA public holidays (extend yearly)
const SA_PUBLIC_HOLIDAYS = new Set([
  '2025-01-01','2025-03-21','2025-04-18','2025-04-21','2025-04-28',
  '2025-05-01','2025-06-16','2025-08-09','2025-09-24',
  '2025-12-16','2025-12-25','2025-12-26',
  '2026-01-01','2026-03-21','2026-03-23','2026-04-03','2026-04-06',
  '2026-04-27','2026-05-01','2026-06-16','2026-08-10','2026-09-24',
  '2026-12-16','2026-12-25','2026-12-26',
]);

// ── Helpers ───────────────────────────────────────────────────────────────────

function sanitize(str) {
  if (typeof str !== 'string') return '';
  return str.trim().replace(/[<>"'&]/g, c => (
    { '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;', '&': '&amp;' }[c]
  ));
}

function genBookingId() {
  const ts  = Date.now().toString(36).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 7).toUpperCase();
  return `BK-${ts}-${rnd}`;
}

function getSurchargeHours(date, time, duration, extraHours) {
  const d   = new Date(date + 'T00:00:00');
  const dow = d.getDay();
  const isWeekend = dow === 0 || dow === 6;
  const isHoliday = SA_PUBLIC_HOLIDAYS.has(date);

  const [hh, mm]    = time.split(':').map(Number);
  const startHour   = hh + mm / 60;
  const totalHours  = (DURATION_HOURS[duration] || 0) + (extraHours || 0);
  const endHour     = startHour + totalHours;

  if (isWeekend || isHoliday) return totalHours;
  if (startHour >= AFTER_HOURS) return totalHours;
  if (endHour > AFTER_HOURS) return endHour - AFTER_HOURS;
  return 0;
}

/**
 * Server-side price calculation — must match calcTotal() in index.html exactly.
 * Returns total in RANDS (integer).
 */
function calcServerAmount(body) {
  const { studios, duration, extraHours = 0, date, time,
          photo, addons = [], cameraBody, rentalDuration, lensChoice,
          discountCode } = body;

  // --- Studio prices
  let studioTotal = 0;
  for (const s of studios) {
    const prices = STUDIO_PRICES[s];
    if (!prices || !prices[duration]) return null;
    studioTotal += prices[duration];
  }

  // --- May promo: 3hrs → pay 2hrs price
  const isInMay = date && new Date(date + 'T00:00:00').getMonth() === 4;
  if (duration === '3hrs' && isInMay) {
    studioTotal = 0;
    for (const s of studios) {
      studioTotal += STUDIO_PRICES[s]['2hrs'];
    }
  }

  // --- Extra hours: R200/hr * number of selected studios
  const extraTotal = (extraHours || 0) * EXTRA_RATE * studios.length;

  // --- Photography package
  const photoTotal = (photo && photo !== 'none') ? (PHOTO_PRICES[photo] || 0) : 0;

  // --- Add-ons
  let addonTotal = 0;
  for (const a of (addons || [])) {
    addonTotal += ADDON_PRICES[a] || 0;
  }

  // --- Camera + lens rental
  let cameraTotal = 0;
  if (cameraBody && rentalDuration && CAMERA_PRICES[cameraBody]) {
    cameraTotal += CAMERA_PRICES[cameraBody][rentalDuration] || 0;
  }
  if (lensChoice && rentalDuration && LENS_PRICES[lensChoice]) {
    cameraTotal += LENS_PRICES[lensChoice][rentalDuration] || 0;
  }

  // --- Surcharge
  const surchargeHours = time ? getSurchargeHours(date, time, duration, extraHours) : 0;
  const surchargeTotal = Math.round(surchargeHours * SURCHARGE_RATE);

  const subtotal = studioTotal + extraTotal + photoTotal + addonTotal + cameraTotal + surchargeTotal;

  // --- Discount code
  const normalCode = (discountCode || '').toUpperCase().trim();
  const discountPct = DISCOUNT_CODES[normalCode] || 0;
  const discountAmt = discountPct ? Math.round(subtotal * discountPct / 100) : 0;

  return subtotal - discountAmt;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Email helpers ─────────────────────────────────────────────────────────────

const DUR_LABELS    = { '90min': '90 minutes', '2hrs': '2 hours', '3hrs': '3 hours', halfday: 'Half day (5hrs)', fullday: 'Full day (10hrs)' };
const STUDIO_NAMES  = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };

async function sendEmails(booking) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) return;

  const from     = process.env.FROM_EMAIL || 'hello@shootstudios.co.za';
  const studios  = booking.studios.map(s => STUDIO_NAMES[s] || s).join(' + ');
  const durLabel = DUR_LABELS[booking.duration] || booking.duration;
  const extraLbl = booking.extraHours > 0 ? ` + ${booking.extraHours} extra hour(s)` : '';
  const paidStr  = `R${(booking.amountPaid / 100).toFixed(2)}`;
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
  <p style="margin:0 0 8px;font-size:12px;line-height:1.7;color:rgba(255,255,255,0.35);">
    Need to make changes? Contact us at
    <a href="mailto:hello@shootstudios.co.za" style="color:rgba(255,255,255,0.6);">hello@shootstudios.co.za</a>
    or call <a href="tel:+27609948107" style="color:rgba(255,255,255,0.6);">060 994 8107</a>.
  </p>
  <p style="margin:48px 0 0;font-size:10px;color:rgba(255,255,255,0.18);">SHOOT. Photographic Studios &nbsp;·&nbsp; 135 Albert Rd, Woodstock, Cape Town</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const studioText =
    `NEW CONFIRMED BOOKING\n${'='.repeat(40)}\n\n` +
    `Ref:       ${booking.bookingId}\n` +
    `Client:    ${booking.firstName} ${booking.lastName}\n` +
    `Email:     ${booking.email}\n` +
    `Phone:     ${booking.phone}\n\n` +
    `Studio:    ${studios}\n` +
    `Date:      ${booking.date}\n` +
    `Time:      ${booking.time}\n` +
    `Duration:  ${durLabel}${extraLbl}\n\n` +
    `Amount:    ${paidStr}\n` +
    `Txn ID:    ${booking.transactionId}\n` +
    `Status:    CONFIRMED (payment received)\n\n` +
    `Photography: ${booking.photo !== 'none' ? booking.photo : 'None'}\n` +
    `Add-ons:     ${(booking.addons || []).join(', ') || 'None'}\n` +
    (booking.cameraBody ? `Camera:      ${booking.cameraBody} — ${booking.rentalDuration}\n` : '') +
    (booking.lensChoice ? `Lens:        ${booking.lensChoice} — ${booking.rentalDuration}\n` : '');

  const post = (payload) => fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body:    JSON.stringify(payload),
  }).catch(e => console.error('[create-booking] email error:', e));

  // Client confirmation
  await post({
    sender:      { name: 'SHOOT. Studios', email: from },
    to:          [{ email: booking.email, name: `${booking.firstName} ${booking.lastName}` }],
    subject:     `Booking Confirmed — ${booking.bookingId}`,
    htmlContent: clientHtml,
  });

  // Studio notification
  await post({
    sender:      { name: 'SHOOT. Bookings', email: from },
    to:          [{ email: 'hello@shootstudios.co.za' }],
    subject:     `[CONFIRMED] ${booking.bookingId} — ${studios} — ${booking.date} ${booking.time}`,
    textContent: studioText,
  });
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const {
    token, studios, duration, date, time,
    firstName, lastName, email, phone,
  } = body;

  // ── 1. Input validation ──────────────────────────────────────────────────
  if (!token || typeof token !== 'string') {
    return res.status(400).json({ error: 'Payment token is required.' });
  }
  if (!Array.isArray(studios) || studios.length === 0) {
    return res.status(400).json({ error: 'Select at least one studio.' });
  }
  if (studios.some(s => !VALID_STUDIOS.has(s))) {
    return res.status(400).json({ error: 'Invalid studio selection.' });
  }
  if (!duration || !VALID_DURATIONS.has(duration)) {
    return res.status(400).json({ error: 'Invalid duration.' });
  }
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'Invalid date format.' });
  }
  if (!time || !TIME_RE.test(time)) {
    return res.status(400).json({ error: 'Invalid time format.' });
  }
  if (!firstName?.trim() || !lastName?.trim()) {
    return res.status(400).json({ error: 'First and last name are required.' });
  }
  if (!email || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'A valid email address is required.' });
  }
  if (!phone?.trim()) {
    return res.status(400).json({ error: 'Phone number is required.' });
  }

  // Reject past dates
  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return res.status(400).json({ error: 'Cannot book a past date.' });
  }

  // Extra hours bounds check
  const extraHours = Math.max(0, Math.min(8, parseInt(body.extraHours, 10) || 0));

  // ── 2. Server-side price calculation ────────────────────────────────────
  const serverAmountRands = calcServerAmount({ ...body, extraHours });
  if (serverAmountRands === null) {
    return res.status(400).json({ error: 'Invalid booking configuration — price calculation failed.' });
  }
  const amountInCents = serverAmountRands * 100;

  const bookingId    = genBookingId();
  const reservedKeys = [];

  try {
    // ── 3. Atomically reserve all time slots ────────────────────────────────
    // Key format: booking:slot:{studio}:{date}:{HH}:{MM}
    // SET ... NX EX 900 → succeeds only if key doesn't exist (atomic)
    for (const studio of studios) {
      const slotKey = `booking:slot:${studio}:${date}:${time}`;
      const result  = await kv('SET', slotKey, `pending:${bookingId}`, 'NX', 'EX', '900');

      if (result !== 'OK') {
        // Slot already taken — release any keys we already reserved
        for (const k of reservedKeys) {
          await kv('DEL', k).catch(() => {});
        }
        return res.status(409).json({
          error:       'This time slot is no longer available. Please choose a different time.',
          slotConflict: true,
          studio,
        });
      }
      reservedKeys.push(slotKey);
    }

    // ── 4. Charge via Yoco ───────────────────────────────────────────────────
    const chargeRes = await fetch(YOCO_CHARGE_URL, {
      method:  'POST',
      headers: {
        'X-Auth-Secret-Key': process.env.YOCO_SECRET_KEY,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ token, amountInCents, currency: 'ZAR' }),
    });

    const charge = await chargeRes.json();

    if (charge.status !== 'successful') {
      // Payment failed — release slot reservations
      for (const k of reservedKeys) {
        await kv('DEL', k).catch(() => {});
      }
      const msg = charge.displayMessage
        || charge.errorMessage
        || 'Payment was declined. Please check your card details and try again.';
      console.error('[create-booking] Yoco charge failed:', charge.errorCode, charge.errorType);
      return res.status(402).json({
        error:         msg,
        paymentFailed: true,
        errorCode:     charge.errorCode,
      });
    }

    // ── 5. Confirm booking ───────────────────────────────────────────────────
    const booking = {
      bookingId,
      studios,
      duration,
      extraHours,
      date,
      time,
      firstName:      sanitize(firstName),
      lastName:       sanitize(lastName),
      email:          email.toLowerCase().trim(),
      phone:          sanitize(phone),
      photo:          body.photo || 'none',
      addons:         Array.isArray(body.addons) ? body.addons.filter(a => ADDON_PRICES[a]) : [],
      cameraBody:     body.cameraBody  || null,
      rentalDuration: body.rentalDuration || null,
      lensChoice:     body.lensChoice  || null,
      discountCode:   (body.discountCode || '').toUpperCase().trim() || null,
      amountPaid:     amountInCents,
      transactionId:  charge.id,
      paymentStatus:  'paid',
      bookingStatus:  'confirmed',
      createdAt:      new Date().toISOString(),
    };

    // Persist booking record (keep for 2 years)
    await kv('SET', `booking:record:${bookingId}`, JSON.stringify(booking), 'EX', String(60 * 60 * 24 * 730));

    // Upgrade slot keys from pending → permanent (no TTL)
    for (const k of reservedKeys) {
      await kv('SET', k, bookingId);
    }

    // ── 6. Send confirmation emails (non-blocking) ───────────────────────────
    sendEmails(booking).catch(e => console.error('[create-booking] sendEmails:', e));

    // Redeem discount code if applied
    if (booking.discountCode && booking.email) {
      fetch(`${req.headers['x-forwarded-proto'] || 'https'}://${req.headers.host}/api/redeem-discount`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ email: booking.email, code: booking.discountCode }),
      }).catch(() => {});
    }

    return res.status(200).json({
      success:       true,
      bookingId,
      transactionId: charge.id,
      amountPaid:    amountInCents,
      message:       'Booking confirmed and payment received.',
    });

  } catch (err) {
    console.error('[create-booking] unexpected error:', err);
    // Release any reserved slots on unexpected error
    for (const k of reservedKeys) {
      await kv('DEL', k).catch(() => {});
    }
    return res.status(500).json({
      error: 'Something went wrong. If you were charged, please contact us immediately at hello@shootstudios.co.za.',
    });
  }
}
