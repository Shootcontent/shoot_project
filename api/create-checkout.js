/**
 * POST /api/create-checkout
 *
 * Validates booking, reserves slots atomically (with overlap detection),
 * creates a Yoco hosted checkout session, and returns the redirect URL.
 *
 * Interval hash:  booking:intervals:{studio}:{date}
 *   field  p:{bookingId}  →  "{startMins}:{endMins}"   (pending, 30-min window)
 *   field  c:{bookingId}  →  "{startMins}:{endMins}"   (confirmed, permanent)
 *
 * Race-condition protection: per-studio-date lock  booking:lock:{studio}:{date}
 */

import { kv, kvHGetAll } from './_kv.js';
import { getCoupon } from './_coupon.js';
import { icsAttachment } from './_ics.js';

const YOCO_CHECKOUT_URL = 'https://payments.yoco.com/api/checkouts';

const VALID_STUDIOS   = new Set(['curve', 'studio1', 'pool']);
const VALID_DURATIONS = new Set(['90min', '2hrs', '3hrs', 'halfday', 'fullday']);
const DATE_RE         = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE         = /^\d{2}:\d{2}$/;
const EMAIL_RE        = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

const STUDIO_PRICES = {
  curve:   { '90min': 550, '2hrs': 900,  '3hrs': 1350, halfday: 1750, fullday: 3300 },
  studio1: { '90min': 550, '2hrs': 700,  '3hrs': 1050, halfday: 1650, fullday: 3150 },
  pool:    { '90min': 850, '2hrs': 1100, '3hrs': 1650, halfday: 2650, fullday: 5300 },
};
const PHOTO_PRICES   = { basic: 1400, standard: 2500, premium: 10000 };
const ADDON_PRICES   = { sunset: 100, snoot: 80, mic: 100, rgb: 150 };
const CAMERA_PRICES  = { rp: { halfday: 400, fullday: 800 }, r6: { halfday: 600, fullday: 1200 } };
const LENS_PRICES    = { '2470': { halfday: 350, fullday: 700 }, '50': { halfday: 250, fullday: 500 } };
const EXTRA_RATE     = 450; // R450/hr base studio rate (surcharge stacks on top when applicable)
const SURCHARGE_RATE = 200;
const START_HOURS    = 8;   // 08:00 — before this triggers early-hours surcharge
const AFTER_HOURS    = 17;  // 17:00 — after this triggers after-hours surcharge

const DURATION_MINS  = { '90min': 90, '2hrs': 120, '3hrs': 180, halfday: 300, fullday: 600 };
const BUFFER_MINS    = 30; // mandatory gap between bookings
const DURATION_HOURS = { '90min': 1.5, '2hrs': 2, '3hrs': 3, halfday: 5, fullday: 10 };

const SA_HOLIDAYS = new Set([
  '2025-01-01','2025-03-21','2025-04-18','2025-04-21','2025-04-28',
  '2025-05-01','2025-06-16','2025-08-09','2025-09-24',
  '2025-12-16','2025-12-25','2025-12-26',
  '2026-01-01','2026-03-21','2026-03-23','2026-04-03','2026-04-06',
  '2026-04-27','2026-05-01','2026-06-16','2026-08-10','2026-09-24',
  '2026-12-16','2026-12-25','2026-12-26',
]);

// ── Pure helpers ──────────────────────────────────────────────────────────────

function sanitize(s) {
  return typeof s === 'string' ? s.trim().replace(/[<>"'&]/g, c =>
    ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c])) : '';
}

function genId() {
  return `BK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

/** "HH:MM" → minutes since midnight */
function timeToMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** True if interval [s1,e1) overlaps [s2,e2) including the mandatory buffer */
function overlaps(s1, e1, s2, e2) {
  return s1 < e2 + BUFFER_MINS && e1 + BUFFER_MINS > s2;
}

function getSurchargeHours(date, time, duration, extra) {
  const d = new Date(date + 'T00:00:00');
  const dow = d.getDay();
  if (dow === 0 || dow === 6 || SA_HOLIDAYS.has(date)) {
    return (DURATION_HOURS[duration] || 0) + (extra || 0);
  }
  const [hh, mm] = time.split(':').map(Number);
  const start  = hh + mm / 60;
  const total  = (DURATION_HOURS[duration] || 0) + (extra || 0);
  const end    = start + total;
  const beforeHours = Math.max(0, Math.min(end, START_HOURS) - start);
  const afterHours  = Math.max(0, end - Math.max(AFTER_HOURS, start));
  return beforeHours + afterHours;
}

async function calcAmount(body) {
  const { studios, duration, extraHours = 0, date, time,
          photo, addons = [], cameraBody, rentalDuration, lensChoice, discountCode } = body;

  let studio = 0;
  for (const s of studios) {
    if (!STUDIO_PRICES[s]?.[duration]) return null;
    studio += STUDIO_PRICES[s][duration];
  }
  const isInMay = date && new Date(date + 'T00:00:00').getMonth() === 4;
  if (duration === '3hrs' && isInMay) {
    studio = studios.reduce((sum, s) => sum + STUDIO_PRICES[s]['2hrs'], 0);
  }

  const extra      = (extraHours || 0) * EXTRA_RATE * studios.length;
  const photoAmt   = (photo && photo !== 'none') ? (PHOTO_PRICES[photo] || 0) : 0;
  const addonAmt   = (addons || []).reduce((s, a) => s + (ADDON_PRICES[a] || 0), 0);
  let   camera     = 0;
  if (cameraBody && rentalDuration) camera += CAMERA_PRICES[cameraBody]?.[rentalDuration] || 0;
  if (lensChoice && rentalDuration) camera += LENS_PRICES[lensChoice]?.[rentalDuration] || 0;
  const surcharge  = time ? Math.round(getSurchargeHours(date, time, duration, extraHours) * SURCHARGE_RATE) : 0;

  const subtotal = studio + extra + photoAmt + addonAmt + camera + surcharge;
  const normalCode = (discountCode || '').toUpperCase().trim();
  let discAmt = 0;
  if (normalCode) {
    const coupon = await getCoupon(normalCode);
    if (coupon && coupon.active) {
      if (coupon.type === 'percent') {
        discAmt = Math.round(subtotal * coupon.value / 100);
      } else if (coupon.type === 'fixed') {
        discAmt = Math.min(coupon.value, subtotal);
      }
    }
  }
  return subtotal - discAmt;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

// ── Interval-hash helpers ─────────────────────────────────────────────────────

/**
 * Returns all valid (non-stale) booked intervals for one studio on one date.
 * Lazily prunes stale pending entries whose backing booking:pending key expired.
 */
async function loadIntervals(studio, date) {
  const hashKey = `booking:intervals:${studio}:${date}`;
  const raw = await kvHGetAll(hashKey);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return [];

  const valid = [];
  const stale = [];

  for (const [field, val] of Object.entries(raw)) {
    if (!val || !val.includes(':')) continue;
    const [startMins, endMins] = val.split(':').map(Number);
    if (isNaN(startMins) || isNaN(endMins)) continue;

    if (field.startsWith('p:')) {
      const bId = field.slice(2);
      const stillPending = await kv('GET', `booking:pending:${bId}`);
      if (!stillPending) { stale.push(field); continue; } // expired pending → skip
    }
    valid.push({ startMins, endMins });
  }

  if (stale.length) kv('HDEL', hashKey, ...stale).catch(() => {});
  return valid;
}

// ── Main handler ──────────────────────────────────────────────────────────────

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { studios, duration, date, time, firstName, lastName, email, phone } = body;

  // ── Validate inputs ───────────────────────────────────────────────────────
  if (!Array.isArray(studios) || !studios.length || studios.some(s => !VALID_STUDIOS.has(s)))
    return res.status(400).json({ error: 'Invalid studio selection.' });
  if (!VALID_DURATIONS.has(duration))
    return res.status(400).json({ error: 'Invalid duration.' });
  if (!date || !DATE_RE.test(date) || date < new Date().toISOString().split('T')[0])
    return res.status(400).json({ error: 'Invalid or past date.' });
  if (!time || !TIME_RE.test(time))
    return res.status(400).json({ error: 'Invalid time.' });
  if (!firstName?.trim() || !lastName?.trim())
    return res.status(400).json({ error: 'Full name required.' });
  if (!email || !EMAIL_RE.test(email))
    return res.status(400).json({ error: 'Valid email required.' });
  if (!phone?.trim())
    return res.status(400).json({ error: 'Phone number required.' });

  const extraHours  = Math.max(0, Math.min(8, parseInt(body.extraHours, 10) || 0));
  const amountRands = await calcAmount({ ...body, extraHours });
  if (amountRands === null) {
    console.error('[create-checkout] Price calculation returned null.', {
      studios, duration, extraHours, date, time,
      photo: body.photo, addons: body.addons,
      discountCode: body.discountCode,
    });
    return res.status(400).json({ error: 'Invalid booking configuration — price calculation failed.' });
  }
  const finalAmount = Math.max(0, amountRands); // defensive: never negative
  const amountCents = finalAmount * 100;

  // Compute the booking's time interval in minutes-since-midnight
  const durMins   = (DURATION_MINS[duration] || 0) + (extraHours * 60);
  const startMins = timeToMins(time);
  const endMins   = startMins + durMins;

  const bookingId  = genId();
  const locksHeld  = [];
  const slotsSet   = [];
  let   succeeded  = false;

  try {
    // ── Acquire locks (sorted to prevent deadlock) ────────────────────────────
    const sortedStudios = [...studios].sort();
    for (const studio of sortedStudios) {
      const lockKey = `booking:lock:${studio}:${date}`;
      const ok = await kv('SET', lockKey, bookingId, 'NX', 'EX', '15');
      if (ok !== 'OK') {
        return res.status(409).json({
          error: 'Another booking for this studio is being processed. Please try again.',
          slotConflict: true,
        });
      }
      locksHeld.push(lockKey);
    }

    // ── Check overlaps & atomically reserve each studio ───────────────────────
    for (const studio of studios) {
      const existing = await loadIntervals(studio, date);

      if (existing.some(e => overlaps(startMins, endMins, e.startMins, e.endMins))) {
        return res.status(409).json({
          error: 'This time range overlaps with an existing booking. Please choose a different time.',
          slotConflict: true,
        });
      }

      // Reserve exact-start-time key (backward-compat + belt-and-suspenders)
      const slotKey = `booking:slot:${studio}:${date}:${time}`;
      const slotOk  = await kv('SET', slotKey, `pending:${bookingId}`, 'NX', 'EX', '1800');
      if (slotOk !== 'OK') {
        return res.status(409).json({
          error: 'This time slot is no longer available. Please choose a different time.',
          slotConflict: true,
        });
      }
      slotsSet.push(slotKey);

      // Record interval as pending in the hash
      await kv('HSET', `booking:intervals:${studio}:${date}`, `p:${bookingId}`, `${startMins}:${endMins}`);
    }

    // ── Build booking record ─────────────────────────────────────────────────
    const bookingRecord = {
      bookingId,
      studios,
      duration,
      extraHours,
      date,
      time,
      startMins,
      endMins,
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
      amountCents,
      paymentStatus:  'pending',
      bookingStatus:  'pending',
      createdAt:      new Date().toISOString(),
    };

    // ── FREE BOOKING (100% discount) — bypass payment provider ────────────────
    if (amountCents === 0) {
      bookingRecord.paymentStatus = 'paid_full_discount';
      bookingRecord.bookingStatus = 'confirmed';
      bookingRecord.confirmedAt   = bookingRecord.createdAt;

      // Save permanent booking record (2-year TTL)
      await kv('SET', `booking:record:${bookingId}`, JSON.stringify(bookingRecord), 'EX', String(60 * 60 * 24 * 730));

      // Upgrade slot keys: remove TTL (make permanent)
      for (const sk of slotsSet) {
        await kv('SET', sk, bookingId);
      }

      // Promote intervals from pending → confirmed
      for (const studio of studios) {
        const hashKey = `booking:intervals:${studio}:${date}`;
        await kv('HDEL', hashKey, `p:${bookingId}`);
        await kv('HSET', hashKey, `c:${bookingId}`, `${startMins}:${endMins}`);
      }

      // Send confirmation emails
      await sendConfirmationEmails(bookingRecord);

      // Redeem discount code
      if (bookingRecord.discountCode) {
        const proto = req.headers['x-forwarded-proto'] || 'https';
        const host  = req.headers.host;
        fetch(`${proto}://${host}/api/redeem-discount`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email: bookingRecord.email, code: bookingRecord.discountCode }),
        }).catch(() => {});
      }

      console.log(`[create-checkout] free booking confirmed bookingId=${bookingId} discount=${bookingRecord.discountCode} amount=R0`);

      succeeded = true;
      return res.status(200).json({ freeBooking: true, bookingId });
    }

    // ── PAID BOOKING — create Yoco hosted checkout ────────────────────────────
    await kv('SET', `booking:pending:${bookingId}`, JSON.stringify(bookingRecord), 'EX', '1800');

    const proto   = req.headers['x-forwarded-proto'] || 'https';
    const host    = req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const studioNames = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
    const description = studios.map(s => studioNames[s] || s).join(' + ');

    const yocoRes = await fetch(YOCO_CHECKOUT_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        amount:     amountCents,
        currency:   'ZAR',
        successUrl: `${baseUrl}/?yoco_success=1&booking_id=${bookingId}`,
        cancelUrl:  `${baseUrl}/?yoco_cancel=1&booking_id=${bookingId}`,
        failureUrl: `${baseUrl}/?yoco_fail=1&booking_id=${bookingId}`,
        metadata:   { bookingId, description },
      }),
    });

    const checkout = await yocoRes.json();

    if (!checkout.redirectUrl) {
      console.error('[create-checkout] Yoco error:', JSON.stringify(checkout));
      return res.status(502).json({ error: 'Payment provider error. Please try again.' });
    }

    await kv('SET', `checkout:${checkout.id}`, bookingId, 'EX', '1800');

    // Update pending booking with checkoutId so verify-payment can verify with Yoco
    bookingRecord.checkoutId = checkout.id;
    await kv('SET', `booking:pending:${bookingId}`, JSON.stringify(bookingRecord), 'EX', '1800');

    console.log(`[create-checkout] checkout created bookingId=${bookingId} checkoutId=${checkout.id} amount=${amountCents}`);

    succeeded = true;
    return res.status(200).json({ redirectUrl: checkout.redirectUrl, bookingId });

  } catch (err) {
    console.error('[create-checkout]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  } finally {
    // Always release locks
    for (const lk of locksHeld) await releaseLock(lk);

    // If we didn't succeed, clean up slot keys and interval entries
    if (!succeeded) {
      for (const sk of slotsSet) await kv('DEL', sk).catch(() => {});
      for (const studio of studios) {
        await kv('HDEL', `booking:intervals:${studio}:${date}`, `p:${bookingId}`).catch(() => {});
      }
      await kv('DEL', `booking:pending:${bookingId}`).catch(() => {});
    }
  }
}

async function releaseLock(lockKey) {
  await kv('DEL', lockKey).catch(() => {});
}

// ── Confirmation emails for free bookings ────────────────────────────────────

const OWNER_EMAILS  = ['hello@shootstudios.co.za', 'elad@asapsolutions.co.za'];
const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';
const STUDIO_LABELS = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS    = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day (5hrs)', fullday: 'Full day (10hrs)' };

async function sendConfirmationEmails(booking) {
  const apiKey = process.env.BREVO_API_KEY;
  if (!apiKey) {
    console.error('[create-checkout] BREVO_API_KEY not set — confirmation emails skipped');
    return;
  }

  const from     = process.env.FROM_EMAIL || 'hello@shootstudios.co.za';
  const studios  = booking.studios.map(s => STUDIO_LABELS[s] || s).join(' + ');
  const durLabel = DUR_LABELS[booking.duration] || booking.duration;
  const extraLbl = booking.extraHours > 0 ? ` + ${booking.extraHours} extra hr(s)` : '';
  const paidStr  = 'R0.00 (100% Discount)';
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
  <p style="margin:0 0 40px;font-size:15px;line-height:1.75;color:rgba(255,255,255,0.55);">Your discount has been applied and your session is locked in. See you at the studio!</p>
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
      <p style="margin:0 0 6px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Amount</p>
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
    `CONFIRMED BOOKING (100% DISCOUNT)\n${'='.repeat(40)}\n\n` +
    `Ref:      ${booking.bookingId}\n` +
    `Client:   ${booking.firstName} ${booking.lastName}\n` +
    `Email:    ${booking.email}\n` +
    `Phone:    ${booking.phone}\n\n` +
    `Studio:   ${studios}\n` +
    `Date:     ${booking.date} at ${booking.time}\n` +
    `Duration: ${durLabel}${extraLbl}\n\n` +
    `Amount:   ${paidStr}\n` +
    `Discount: ${booking.discountCode}\n` +
    `Status:   CONFIRMED (fully discounted — no payment collected)`;

  const post = async (payload) => {
    try {
      const r = await fetch(BREVO_API_URL, {
        method:  'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body:    JSON.stringify(payload),
      });
      if (!r.ok) {
        const body = await r.text();
        console.error('[create-checkout] Brevo error', r.status, body);
      }
    } catch (e) {
      console.error('[create-checkout] email fetch failed:', e.message);
    }
  };

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
    subject:     `[CONFIRMED] ${booking.bookingId} — ${studios} — ${booking.date} ${booking.time} (100% Discount)`,
    textContent: studioNote,
    attachment,
  });
}
