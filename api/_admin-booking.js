/**
 * _admin-booking.js — Admin quote + payment request helpers
 *
 * Flow:
 *   1. Admin creates quote (draft) → booking:quote:{quoteId}
 *   2. Admin sends payment request → slots locked, email sent, token stored
 *   3. Customer opens link, pays via Yoco hosted checkout
 *   4. verify-admin-payment promotes quote → booking:record
 *
 * Slot integration (no existing files modified):
 *   Admin quotes use `a:{quoteId}` entries in booking:intervals:{studio}:{date}
 *   These are never pruned by check-availability or create-checkout (only `p:` is pruned)
 *   so admin slot reservations block customer bookings automatically.
 */

import crypto from 'crypto';
import { kv, kvHGetAll } from './_kv.js';

// ── Constants ─────────────────────────────────────────────────────────────────
const DURATION_MINS = { '90min': 90, '2hrs': 120, '3hrs': 180, halfday: 300, fullday: 600 };
const STUDIO_NAMES  = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS    = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day (5 hrs)', fullday: 'Full day (10 hrs)' };
const QUOTE_TTL     = 60 * 60 * 24 * 30;  // 30 days
const PAYMENT_TTL   = 60 * 60 * 48;        // 48 hours default
const BUFFER_MINS   = 30;                  // mandatory gap between bookings

// ── ID + token generators ─────────────────────────────────────────────────────
export function genQuoteId() {
  return `QT-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 6).toUpperCase()}`;
}
export function genPaymentToken() {
  return crypto.randomBytes(32).toString('hex'); // 64-char hex, non-guessable
}

// ── Lock helpers (same pattern as create-checkout.js) ─────────────────────────
async function acquireLock(studio, date, holder) {
  const ok = await kv('SET', `booking:lock:${studio}:${date}`, holder, 'NX', 'EX', '15');
  return ok === 'OK';
}
async function releaseLock(studio, date) {
  await kv('DEL', `booking:lock:${studio}:${date}`).catch(() => {});
}

// ── Time helpers ──────────────────────────────────────────────────────────────
function timeToMins(t) { const [h, m] = t.split(':').map(Number); return h * 60 + m; }

function overlaps(s1, e1, s2, e2) { return s1 < e2 && e1 > s2; }

/** Overlap check that includes the mandatory buffer on both sides */
function overlapsWithBuffer(s1, e1, s2, e2) {
  return s1 < e2 + BUFFER_MINS && e1 + BUFFER_MINS > s2;
}

// ── Quote CRUD ────────────────────────────────────────────────────────────────

/**
 * Create a new admin quote (draft). Does NOT lock slots yet.
 * Slots are locked when payment request is sent.
 */
export async function createQuote({
  studios, duration, extraHours = 0, date, time,
  firstName, lastName, email, phone,
  customPriceCents, discountCode, notes,
  createdBy,
}) {
  const quoteId    = genQuoteId();
  const startMins  = timeToMins(time);
  const durMins    = (DURATION_MINS[duration] || 0) + extraHours * 60;
  const endMins    = startMins + durMins;

  const quote = {
    quoteId,
    studios,
    duration,
    extraHours,
    date,
    time,
    startMins,
    endMins,
    firstName,
    lastName,
    email,
    phone,
    customPriceCents: customPriceCents || 0,
    discountCode:     discountCode || null,
    notes:            notes || '',
    createdBy,
    createdAt:        new Date().toISOString(),
    status:           'draft',
    slotsLocked:      false,
    paymentToken:     null,
  };

  await kv('SET', `booking:quote:${quoteId}`, JSON.stringify(quote), 'EX', String(QUOTE_TTL));
  await kv('SADD', 'booking:idx:quotes', quoteId);
  await kv('SADD', 'booking:idx:drafts', quoteId);

  return quote;
}

export async function getQuote(quoteId) {
  const raw = await kv('GET', `booking:quote:${quoteId}`);
  if (!raw) return null;
  try { return JSON.parse(raw); } catch { return null; }
}

export async function updateQuote(quoteId, updates) {
  const quote = await getQuote(quoteId);
  if (!quote) throw new Error('Quote not found.');
  const updated = { ...quote, ...updates };
  const ttl = await kv('TTL', `booking:quote:${quoteId}`);
  const ex  = ttl > 0 ? ttl : QUOTE_TTL;
  await kv('SET', `booking:quote:${quoteId}`, JSON.stringify(updated), 'EX', String(ex));
  return updated;
}

export async function listQuotes() {
  const ids = await kv('SMEMBERS', 'booking:idx:quotes');
  if (!ids || ids.length === 0) return [];
  const quotes = await Promise.all(ids.map(getQuote));
  return quotes
    .filter(Boolean)
    .sort((a, b) => b.createdAt > a.createdAt ? 1 : -1);
}

/** Cancel a quote: release locked slots and remove from active indexes. */
export async function cancelQuote(quoteId) {
  const quote = await getQuote(quoteId);
  if (!quote) throw new Error('Quote not found.');

  if (quote.slotsLocked) await unlockQuoteSlots(quote);

  await updateQuote(quoteId, { status: 'cancelled', slotsLocked: false });
  await kv('SREM', 'booking:idx:quotes', quoteId);
  await kv('SREM', 'booking:idx:drafts', quoteId);
  await kv('SREM', 'booking:idx:pending-payment', quoteId);
}

// ── Slot locking ──────────────────────────────────────────────────────────────

/**
 * Lock slots for an admin quote. Acquires booking:lock per studio.
 * Checks for confirmed-booking conflicts (hard error).
 * Pending customer conflicts are allowed (admin takes priority).
 */
export async function lockQuoteSlots(quote) {
  const { quoteId, studios, date, time, startMins, endMins } = quote;
  const locksHeld = [];

  // Acquire locks in sorted order (same pattern as create-checkout.js to prevent deadlock)
  for (const studio of [...studios].sort()) {
    const ok = await acquireLock(studio, date, `admin-quote:${quoteId}`);
    if (!ok) {
      for (const s of locksHeld) await releaseLock(s, date);
      throw new Error(`Studio ${studio} is busy. Retry in a moment.`);
    }
    locksHeld.push(studio);
  }

  try {
    for (const studio of studios) {
      const hashKey = `booking:intervals:${studio}:${date}`;
      const raw     = await kvHGetAll(hashKey);

      // Check for conflicts with confirmed bookings (including 30-min buffer)
      if (raw) {
        for (const [field, val] of Object.entries(raw)) {
          if (!field.startsWith('c:')) continue;
          const [s, e] = val.split(':').map(Number);
          if (overlapsWithBuffer(startMins, endMins, s, e)) {
            throw new Error(`Conflicts with a confirmed booking in ${STUDIO_NAMES[studio] || studio} — a 30-minute buffer is required between bookings.`);
          }
        }
      }

      await kv('HSET', hashKey, `a:${quoteId}`, `${startMins}:${endMins}`);
      // Also claim the exact-time slot key (NX — don't overwrite confirmed bookings)
      await kv('SET', `booking:slot:${studio}:${date}:${time}`, `admin-quote:${quoteId}`, 'NX');
    }

    await updateQuote(quoteId, { slotsLocked: true });
  } finally {
    for (const studio of locksHeld) await releaseLock(studio, date);
  }
}

/** Release slots held by a quote. */
export async function unlockQuoteSlots(quote) {
  const { quoteId, studios, date, time } = quote;
  for (const studio of studios) {
    await kv('HDEL', `booking:intervals:${studio}:${date}`, `a:${quoteId}`).catch(() => {});
    const slotVal = await kv('GET', `booking:slot:${studio}:${date}:${time}`);
    if (slotVal === `admin-quote:${quoteId}`) {
      await kv('DEL', `booking:slot:${studio}:${date}:${time}`).catch(() => {});
    }
  }
}

// ── Payment requests ──────────────────────────────────────────────────────────

export async function createPaymentRequest({ quoteId, amountCents, expiresInHours = 48, createdBy }) {
  const token     = genPaymentToken();
  const expiresAt = new Date(Date.now() + expiresInHours * 3600 * 1000).toISOString();
  const request   = {
    token, quoteId, amountCents, expiresAt,
    createdAt:  new Date().toISOString(),
    createdBy,
    status:     'pending',
    checkoutId: null,
    emailedAt:  null,
    paidAt:     null,
  };

  await kv('SET', `booking:payment_request:${token}`, JSON.stringify(request), 'EX', String(expiresInHours * 3600 + 300));
  await kv('SADD', 'booking:idx:payment-requests', token);

  return request;
}

export async function getPaymentRequest(token) {
  const raw = await kv('GET', `booking:payment_request:${token}`);
  if (!raw) return null;
  try {
    const req = JSON.parse(raw);
    // Lazy expiry check
    if (req.status === 'pending' && new Date(req.expiresAt) < new Date()) {
      req.status = 'expired';
      await kv('SET', `booking:payment_request:${token}`, JSON.stringify(req), 'EX', '3600');
      // Release slots
      const quote = await getQuote(req.quoteId);
      if (quote && quote.slotsLocked) {
        await unlockQuoteSlots(quote);
        await updateQuote(req.quoteId, { status: 'expired', slotsLocked: false });
      }
    }
    return req;
  } catch { return null; }
}

export async function updatePaymentRequest(token, updates) {
  const req = await getPaymentRequest(token);
  if (!req) throw new Error('Payment request not found.');
  const updated = { ...req, ...updates };
  const ttl = await kv('TTL', `booking:payment_request:${token}`);
  const ex  = ttl > 0 ? ttl : PAYMENT_TTL;
  await kv('SET', `booking:payment_request:${token}`, JSON.stringify(updated), 'EX', String(ex));
  return updated;
}

export async function listPaymentRequests() {
  const tokens = await kv('SMEMBERS', 'booking:idx:payment-requests');
  if (!tokens || tokens.length === 0) return [];
  const requests = await Promise.all(tokens.map(getPaymentRequest));
  return requests.filter(Boolean).sort((a, b) => b.createdAt > a.createdAt ? 1 : -1);
}

// ── Promote quote to confirmed booking ────────────────────────────────────────

/**
 * Promotes an admin quote to a confirmed booking record.
 * Upgrades slot keys from admin-quote → permanent.
 * Called after successful payment verification.
 */
export async function promoteQuoteToBooking(quote, { transactionId, paidAmountCents }) {
  const { quoteId, studios, date, time, startMins, endMins } = quote;

  const bookingId = quoteId.replace('QT-', 'BK-');

  const record = {
    bookingId,
    quoteId,
    studios,
    duration:       quote.duration,
    extraHours:     quote.extraHours || 0,
    date,
    time,
    startMins,
    endMins,
    firstName:      quote.firstName,
    lastName:       quote.lastName,
    email:          quote.email,
    phone:          quote.phone,
    amountCents:    paidAmountCents || quote.customPriceCents,
    transactionId:  transactionId || null,
    paymentStatus:  'paid',
    bookingStatus:  'confirmed',
    source:         'admin',
    createdBy:      quote.createdBy,
    notes:          quote.notes || '',
    discountCode:   quote.discountCode || null,
    createdAt:      quote.createdAt,
    confirmedAt:    new Date().toISOString(),
  };

  // Save permanent booking record (2-year TTL — same as existing flow)
  await kv('SET', `booking:record:${bookingId}`, JSON.stringify(record), 'EX', String(60 * 60 * 24 * 730));

  // Promote slot keys: change from admin-quote → permanent
  for (const studio of studios) {
    // Upgrade slot key
    await kv('SET', `booking:slot:${studio}:${date}:${time}`, bookingId);
    // Promote interval: remove a: entry, add c: confirmed entry
    await kv('HDEL', `booking:intervals:${studio}:${date}`, `a:${quoteId}`);
    await kv('HSET', `booking:intervals:${studio}:${date}`, `c:${bookingId}`, `${startMins}:${endMins}`);
  }

  // Update quote status
  await updateQuote(quoteId, { status: 'confirmed', bookingId, slotsLocked: false });
  await kv('SREM', 'booking:idx:pending-payment', quoteId);

  return record;
}

// ── Email helper for payment requests ────────────────────────────────────────

export async function sendPaymentRequestEmail({ quote, token, amountCents, expiresAt, proto, host }) {
  const apiKey    = process.env.BREVO_API_KEY;
  const from      = process.env.FROM_EMAIL || 'hello@shootstudios.co.za';
  if (!apiKey) throw new Error('BREVO_API_KEY not set.');

  const payLink   = `${proto}://${host}/pay.html?token=${token}`;
  const studioLbl = quote.studios.map(s => STUDIO_NAMES[s] || s).join(' + ');
  const durLbl    = DUR_LABELS[quote.duration] || quote.duration;
  const amountStr = `R ${(amountCents / 100).toFixed(0)}`;
  const expStr    = new Date(expiresAt).toLocaleDateString('en-ZA', { day: 'numeric', month: 'long', year: 'numeric' });
  const dateStr   = new Date(quote.date + 'T12:00:00').toLocaleDateString('en-ZA', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });

  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;">
<table width="100%" cellpadding="0" cellspacing="0" border="0">
<tr><td align="center" style="padding:48px 24px 64px;">
<table width="100%" style="max-width:520px;" cellpadding="0" cellspacing="0" border="0">
<tr><td>
  <p style="margin:0 0 40px;font-size:10px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;color:rgba(255,255,255,0.3);">SHOOT. Photographic Studios</p>
  <h1 style="margin:0 0 16px;font-size:34px;font-weight:900;font-style:italic;color:#fff;line-height:1;letter-spacing:-1.5px;">Payment Request.</h1>
  <p style="margin:0 0 36px;font-size:15px;line-height:1.75;color:rgba(255,255,255,0.55);">Hi ${quote.firstName}, a booking has been prepared for you. Complete your payment to confirm your session.</p>
  <table width="100%" cellpadding="0" cellspacing="0" border="0" style="border:1px solid rgba(255,255,255,0.12);margin-bottom:32px;">
    <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Studio</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${studioLbl}</p>
    </td></tr>
    <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Date &amp; Time</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${dateStr} at ${quote.time}</p>
    </td></tr>
    <tr><td style="padding:18px 24px;border-bottom:1px solid rgba(255,255,255,0.08);">
      <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Duration</p>
      <p style="margin:0;font-size:15px;font-weight:700;color:#fff;">${durLbl}</p>
    </td></tr>
    <tr><td style="padding:18px 24px;">
      <p style="margin:0 0 4px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Amount Due</p>
      <p style="margin:0;font-size:24px;font-weight:900;color:#fff;">${amountStr}</p>
    </td></tr>
  </table>
  <a href="${payLink}" style="display:block;background:#fff;color:#000;text-align:center;padding:16px;font-size:11px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;text-decoration:none;margin-bottom:28px;">Pay Now</a>
  <p style="margin:0 0 12px;font-size:12px;color:rgba(255,255,255,0.3);">Or copy this link: <span style="color:rgba(255,255,255,0.5)">${payLink}</span></p>
  <p style="margin:0;font-size:12px;color:rgba(255,255,255,0.25);">This payment link expires on ${expStr}. Questions? <a href="mailto:hello@shootstudios.co.za" style="color:rgba(255,255,255,0.4)">hello@shootstudios.co.za</a></p>
  <p style="margin:48px 0 0;font-size:10px;color:rgba(255,255,255,0.18);">SHOOT. Photographic Studios &nbsp;·&nbsp; 135 Albert Rd, Woodstock, Cape Town</p>
</td></tr>
</table>
</td></tr>
</table>
</body></html>`;

  const r = await fetch('https://api.brevo.com/v3/smtp/email', {
    method:  'POST',
    headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      sender:      { name: 'SHOOT. Studios', email: from },
      to:          [{ email: quote.email, name: `${quote.firstName} ${quote.lastName}` }],
      subject:     `Payment Request — ${studioLbl} on ${quote.date}`,
      htmlContent: html,
    }),
  });

  if (!r.ok) {
    const body = await r.text();
    throw new Error(`Brevo error ${r.status}: ${body}`);
  }
}
