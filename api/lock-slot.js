// api/lock-slot.js — validates booking, checks Redis for conflicts, locks slots for 10 min

const { randomUUID }  = require('crypto');
const { slotKeys, acquireLocks, redis } = require('./_redis');

const DURATION_HOURS = { '90min':1.5, '2hrs':2, '3hrs':3, 'halfday':5, 'fullday':10 };
const LOCK_TTL       = 600; // 10 minutes in seconds

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { studios, date, startTime, durationKey, extraHours, totalAmount, bookingData } = req.body || {};

  // ── Validate ────────────────────────────────────────────────────────────────
  if (!Array.isArray(studios) || !studios.length) return res.status(400).json({ error: 'Select at least one studio' });
  if (!date || !startTime || !durationKey)         return res.status(400).json({ error: 'Missing date, time or duration' });
  if (!DURATION_HOURS[durationKey])                return res.status(400).json({ error: 'Invalid duration' });
  if (!bookingData?.firstName || !bookingData?.email) return res.status(400).json({ error: 'Customer details required' });

  const durationHrs = DURATION_HOURS[durationKey] + Math.max(0, Number(extraHours) || 0);
  const [h, m]      = startTime.split(':').map(Number);
  const endMins     = h * 60 + m + Math.round(durationHrs * 60);
  if (Math.floor(endMins / 60) >= 24) return res.status(400).json({ error: 'Booking extends past midnight' });

  const endTime   = `${String(Math.floor(endMins/60)).padStart(2,'0')}:${String(endMins%60).padStart(2,'0')}`;
  const keys      = slotKeys(studios, date, startTime, durationHrs);
  const bookingId = randomUUID();
  const lockToken = randomUUID();
  const expiresAt = new Date(Date.now() + LOCK_TTL * 1000).toISOString();

  // ── Atomically lock all 30-min slots in Redis ────────────────────────────────
  const locked = await acquireLocks(keys, `lock:${bookingId}`, LOCK_TTL);

  if (!locked) {
    return res.status(409).json({
      error:           'That time slot is no longer available — please choose a different time.',
      slotUnavailable: true,
    });
  }

  // ── Store booking data (needed to send confirmation email later) ─────────────
  const record = {
    ...bookingData,
    studios, date, startTime, endTime, durationKey,
    extraHours:       Math.max(0, Number(extraHours) || 0),
    totalAmount:      Number(totalAmount),
    totalAmountCents: Math.round(Number(totalAmount) * 100),
    lockToken,
    slotKeys:         keys,
    status:           'locked',
    createdAt:        new Date().toISOString(),
  };

  await redis('SET', `booking:${bookingId}`, JSON.stringify(record), 'EX', String(LOCK_TTL * 6));

  return res.status(200).json({
    success: true, bookingId, lockToken, lockExpiresAt: expiresAt,
    message: 'Slot locked for 10 minutes',
  });
};
