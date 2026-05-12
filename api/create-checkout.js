/**
 * POST /api/create-checkout
 *
 * Validates booking, reserves slots atomically, creates a Yoco hosted
 * checkout session, and returns the redirect URL.
 *
 * Flow: frontend → POST here → redirect to Yoco → Yoco redirects to
 * /?yoco_success=1&checkoutId=xxx → frontend calls /api/verify-payment
 */

import { kv } from './_kv.js';

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
const EXTRA_RATE     = 200;
const SURCHARGE_RATE = 200;
const AFTER_HOURS    = 17;
const DURATION_HOURS = { '90min': 1.5, '2hrs': 2, '3hrs': 3, halfday: 5, fullday: 10 };
const DISCOUNT_CODES = { SHOOT10: 10 };

const SA_HOLIDAYS = new Set([
  '2025-01-01','2025-03-21','2025-04-18','2025-04-21','2025-04-28',
  '2025-05-01','2025-06-16','2025-08-09','2025-09-24',
  '2025-12-16','2025-12-25','2025-12-26',
  '2026-01-01','2026-03-21','2026-03-23','2026-04-03','2026-04-06',
  '2026-04-27','2026-05-01','2026-06-16','2026-08-10','2026-09-24',
  '2026-12-16','2026-12-25','2026-12-26',
]);

function sanitize(s) {
  return typeof s === 'string' ? s.trim().replace(/[<>"'&]/g, c =>
    ({ '<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;','&':'&amp;' }[c])) : '';
}

function genId() {
  return `BK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2,7).toUpperCase()}`;
}

function getSurchargeHours(date, time, duration, extra) {
  const d = new Date(date + 'T00:00:00');
  const dow = d.getDay();
  if (dow === 0 || dow === 6 || SA_HOLIDAYS.has(date)) {
    return (DURATION_HOURS[duration] || 0) + (extra || 0);
  }
  const [hh, mm] = time.split(':').map(Number);
  const start = hh + mm / 60;
  const total = (DURATION_HOURS[duration] || 0) + (extra || 0);
  if (start >= AFTER_HOURS) return total;
  if (start + total > AFTER_HOURS) return (start + total) - AFTER_HOURS;
  return 0;
}

function calcAmount(body) {
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

  const subtotal   = studio + extra + photoAmt + addonAmt + camera + surcharge;
  const discPct    = DISCOUNT_CODES[(discountCode || '').toUpperCase().trim()] || 0;
  const discAmt    = discPct ? Math.round(subtotal * discPct / 100) : 0;
  return subtotal - discAmt;
}

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const body = req.body || {};
  const { studios, duration, date, time, firstName, lastName, email, phone } = body;

  // ── Validate ────────────────────────────────────────────────────────────────
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

  const extraHours   = Math.max(0, Math.min(8, parseInt(body.extraHours, 10) || 0));
  const amountRands  = calcAmount({ ...body, extraHours });
  if (!amountRands) return res.status(400).json({ error: 'Invalid booking configuration.' });
  const amountCents  = amountRands * 100;

  const bookingId    = genId();
  const reservedKeys = [];

  try {
    // ── Reserve slots atomically ───────────────────────────────────────────────
    for (const studio of studios) {
      const slotKey = `booking:slot:${studio}:${date}:${time}`;
      const result  = await kv('SET', slotKey, `pending:${bookingId}`, 'NX', 'EX', '1800');
      if (result !== 'OK') {
        for (const k of reservedKeys) await kv('DEL', k).catch(() => {});
        return res.status(409).json({
          error: 'This time slot is no longer available. Please choose a different time.',
          slotConflict: true,
        });
      }
      reservedKeys.push(slotKey);
    }

    // ── Store pending booking ──────────────────────────────────────────────────
    const pendingBooking = {
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
      amountCents,
      paymentStatus:  'pending',
      bookingStatus:  'pending',
      createdAt:      new Date().toISOString(),
    };

    await kv('SET', `booking:pending:${bookingId}`, JSON.stringify(pendingBooking), 'EX', '1800');

    // ── Create Yoco hosted checkout ────────────────────────────────────────────
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
      // Yoco checkout creation failed — release reserved slots
      for (const k of reservedKeys) await kv('DEL', k).catch(() => {});
      await kv('DEL', `booking:pending:${bookingId}`).catch(() => {});
      console.error('[create-checkout] Yoco error:', JSON.stringify(checkout));
      return res.status(502).json({ error: 'Payment provider error. Please try again.' });
    }

    // Store checkoutId → bookingId for verification
    await kv('SET', `checkout:${checkout.id}`, bookingId, 'EX', '1800');

    return res.status(200).json({ redirectUrl: checkout.redirectUrl, bookingId });

  } catch (err) {
    console.error('[create-checkout]', err);
    for (const k of reservedKeys) await kv('DEL', k).catch(() => {});
    await kv('DEL', `booking:pending:${bookingId}`).catch(() => {});
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
