// api/release-slot.js — releases slot locks on cancel/failure

const { releaseSlots, redis } = require('./_redis');

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, lockToken } = req.body || {};
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

  try {
    const raw = await redis('GET', `booking:${bookingId}`);
    if (raw) {
      const booking = JSON.parse(raw);
      if (booking.lockToken === lockToken && booking.status !== 'confirmed') {
        if (booking.slotKeys?.length) await releaseSlots(booking.slotKeys);
        await redis('SET', `booking:${bookingId}`, JSON.stringify({ ...booking, status: 'cancelled' }));
      }
    }
  } catch (err) {
    console.error('[release-slot] error:', err.message);
  }

  return res.status(200).json({ success: true });
};
