// api/lock-slot.js
// Validates the booking data and returns a lock token.
// For testing: no database required — validation only.

const DURATION_HOURS = {
  '90min': 1.5, '2hrs': 2, '3hrs': 3, 'halfday': 5, 'fullday': 10,
};

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { studios, date, startTime, durationKey, extraHours, totalAmount, bookingData } = req.body || {};

  if (!Array.isArray(studios) || !studios.length) return res.status(400).json({ error: 'Select at least one studio' });
  if (!date || !startTime || !durationKey)         return res.status(400).json({ error: 'Missing date, time or duration' });
  if (!DURATION_HOURS[durationKey])                return res.status(400).json({ error: 'Invalid duration' });
  if (!bookingData?.firstName || !bookingData?.email) return res.status(400).json({ error: 'Customer details required' });

  const durationHrs = DURATION_HOURS[durationKey] + Math.max(0, Number(extraHours) || 0);
  const [h, m]      = startTime.split(':').map(Number);
  const endMins     = h * 60 + m + Math.round(durationHrs * 60);
  const endH        = Math.floor(endMins / 60);
  const endM        = endMins % 60;
  if (endH >= 24) return res.status(400).json({ error: 'Booking extends past midnight' });

  const { randomUUID } = require('crypto');
  const bookingId      = randomUUID();
  const lockToken      = randomUUID();
  const expiresAt      = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  return res.status(200).json({
    success:       true,
    bookingId,
    lockToken,
    lockExpiresAt: expiresAt,
    message:       'Slot validated — proceeding to payment',
  });
};
