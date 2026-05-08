// api/lock-slot.js
// Atomically reserves a studio time slot for 10 minutes while the customer pays.
// Uses a Postgres function so concurrent requests cannot both succeed.

const { createClient } = require('@supabase/supabase-js');

const DURATION_HOURS = {
  '90min':   1.5,
  '2hrs':    2,
  '3hrs':    3,
  'halfday': 5,
  'fullday': 10,
};

const ALLOWED_ORIGIN = process.env.SITE_URL || 'https://www.shootstudios.co.za';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const {
    studios,      // string[]  e.g. ['curve', 'studio1']
    date,         // string    e.g. '2025-06-15'
    startTime,    // string    e.g. '10:00'
    durationKey,  // string    e.g. '2hrs'
    extraHours,   // number
    totalAmount,  // number    in ZAR (rands)
    bookingData,  // object    customer + booking details
  } = req.body || {};

  // ── Input validation ────────────────────────────────────────────────────────
  if (!Array.isArray(studios) || studios.length === 0)
    return res.status(400).json({ error: 'Select at least one studio' });
  if (!date || !startTime || !durationKey)
    return res.status(400).json({ error: 'Missing date, startTime or durationKey' });
  if (totalAmount === undefined || totalAmount < 0)
    return res.status(400).json({ error: 'Invalid totalAmount' });
  if (!bookingData?.firstName || !bookingData?.lastName || !bookingData?.email || !bookingData?.phone)
    return res.status(400).json({ error: 'Customer details incomplete' });
  if (!DURATION_HOURS[durationKey])
    return res.status(400).json({ error: 'Invalid durationKey' });

  // Basic email format check
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(bookingData.email))
    return res.status(400).json({ error: 'Invalid email address' });

  // ── Calculate end time ──────────────────────────────────────────────────────
  const durationHrs = DURATION_HOURS[durationKey] + Math.max(0, Number(extraHours) || 0);
  const [h, m]      = startTime.split(':').map(Number);
  const endMins     = h * 60 + m + Math.round(durationHrs * 60);
  const endH        = Math.floor(endMins / 60);
  const endM        = endMins % 60;
  const endTime     = `${String(endH).padStart(2, '0')}:${String(endM).padStart(2, '0')}`;

  if (endH >= 24) return res.status(400).json({ error: 'Booking would extend past midnight' });

  // ── Supabase ────────────────────────────────────────────────────────────────
  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  const totalCents = Math.round(Number(totalAmount) * 100);

  const { data, error } = await supabase.rpc('lock_slot_atomic', {
    p_studios:            studios,
    p_date:               date,
    p_start_time:         startTime,
    p_end_time:           endTime,
    p_booking_data: {
      ...bookingData,
      durationKey,
      extraHours:          Math.max(0, Number(extraHours) || 0),
      totalAmount:         Number(totalAmount),
      totalAmountCents:    totalCents,
      promoApplied:        Boolean(bookingData.promoApplied),
      promoDiscountCents:  Math.round(Number(bookingData.promoDiscountCents) || 0),
    },
    p_total_amount_cents: totalCents,
  });

  if (error) {
    console.error('[lock-slot] Supabase RPC error:', error);
    return res.status(500).json({ error: 'Database error — please try again' });
  }

  const result = data?.[0];

  if (!result?.success) {
    return res.status(409).json({
      error:           result?.message || 'Slot unavailable',
      slotUnavailable: true,
    });
  }

  return res.status(200).json({
    success:       true,
    bookingId:     result.booking_id,
    lockToken:     result.lock_token,
    lockExpiresAt: result.lock_expires_at,
    message:       result.message,
  });
};
