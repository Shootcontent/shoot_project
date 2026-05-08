// api/available-slots.js
// Returns which time slots are unavailable for a given studio and date.
// Called by the frontend to grey out taken slots in the time picker (future enhancement).
// Safe to expose — returns no customer PII, only boolean availability.

const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Cache-Control', 'public, max-age=30'); // 30s cache

  if (req.method !== 'GET') return res.status(405).end();

  const { date, studios } = req.query;

  if (!date) return res.status(400).json({ error: 'Missing date' });

  const studioList = studios ? studios.split(',') : ['curve', 'studio1', 'pool'];

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // Confirmed bookings on this date
  const { data: confirmedBookings } = await supabase
    .from('bookings')
    .select('studios, start_time, end_time')
    .eq('date',   date)
    .eq('status', 'confirmed')
    .overlaps('studios', studioList);

  // Active locks on this date (customer currently paying)
  const { data: activeLocks } = await supabase
    .from('slot_locks')
    .select('studios, start_time, end_time, expires_at')
    .eq('date',   date)
    .eq('status', 'active')
    .gt('expires_at', new Date().toISOString())
    .overlaps('studios', studioList);

  const blockedSlots = [
    ...(confirmedBookings || []).map(b => ({
      studios:   b.studios,
      startTime: b.start_time,
      endTime:   b.end_time,
      type:      'confirmed',
    })),
    ...(activeLocks || []).map(l => ({
      studios:    l.studios,
      startTime:  l.start_time,
      endTime:    l.end_time,
      type:       'locked',
      expiresAt:  l.expires_at,
    })),
  ];

  return res.status(200).json({ date, studios: studioList, blockedSlots });
};
