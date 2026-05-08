// api/release-slot.js
// Called by booking-cancel.html (and internally on checkout creation failure)
// to release a slot lock early, restoring availability immediately.

const { createClient } = require('@supabase/supabase-js');

const ALLOWED_ORIGIN = process.env.SITE_URL || 'https://www.shootstudios.co.za';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, lockToken } = req.body || {};

  if (!bookingId || !lockToken) {
    return res.status(400).json({ error: 'Missing bookingId or lockToken' });
  }

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Verify the lock token matches the booking (prevents spoofing)
  const { data: lock } = await supabase
    .from('slot_locks')
    .select('id, status, booking_id')
    .eq('lock_token',  lockToken)
    .eq('booking_id',  bookingId)
    .maybeSingle();

  if (!lock) {
    return res.status(404).json({ error: 'Lock not found' });
  }

  // Never release a confirmed booking's lock
  const { data: booking } = await supabase
    .from('bookings')
    .select('status')
    .eq('id', bookingId)
    .maybeSingle();

  if (booking?.status === 'confirmed') {
    return res.status(200).json({ message: 'Booking is confirmed — no release needed' });
  }

  // Release
  await supabase
    .from('slot_locks')
    .update({ status: 'released' })
    .eq('lock_token',  lockToken)
    .eq('booking_id',  bookingId)
    .eq('status',      'active');

  await supabase
    .from('bookings')
    .update({ status: 'cancelled' })
    .eq('id', bookingId)
    .in('status', ['pending', 'locked']);

  return res.status(200).json({ success: true, message: 'Slot released' });
};
