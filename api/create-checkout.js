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
const EXTRA_RATE     = 650; // R650/hr per selected studio (R450 studio rate + R200 overtime surcharge)
const SURCHARGE_RATE = 200;
const AFTER_HOURS    = 17;

const DURATION_MINS  = { '90min': 90, '2hrs': 120, '3hrs': 180, halfday: 300, fullday: 600 };
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

/** True if interval [s1,e1) overlaps [s2,e2) */
function overlaps(s1, e1, s2, e2) {
  return s1 < e2 && e1 > s2;
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
  const amountRands = calcAmount({ ...body, extraHours });
  if (!amountRands) return res.status(400).json({ error: 'Invalid booking configuration.' });
  const amountCents = amountRands * 100;

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

    // ── Store pending booking record ──────────────────────────────────────────
    const pendingBooking = {
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

    await kv('SET', `booking:pending:${bookingId}`, JSON.stringify(pendingBooking), 'EX', '1800');

    // ── Create Yoco hosted checkout ───────────────────────────────────────────
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
