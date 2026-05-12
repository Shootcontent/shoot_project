/**
 * GET /api/check-availability?date=YYYY-MM-DD&studios=curve,studio1,pool
 *
 * Returns all booked (or pending) time slots for the given studios on a date.
 * Frontend uses this to disable unavailable options in the time picker.
 */

import { kv } from './_kv.js';

const VALID_STUDIOS = new Set(['curve', 'studio1', 'pool']);
const DATE_RE       = /^\d{4}-\d{2}-\d{2}$/;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, studios } = req.query;

  // Validate date
  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date. Use YYYY-MM-DD format.' });
  }

  // Reject past dates
  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return res.status(400).json({ error: 'Cannot check availability for past dates.' });
  }

  // Validate studios
  const studioList = (studios || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => VALID_STUDIOS.has(s));

  if (studioList.length === 0) {
    return res.status(400).json({ error: 'Provide at least one valid studio (curve, studio1, pool).' });
  }

  try {
    const bookedSlots = {};

    for (const studio of studioList) {
      // KEYS returns all slot keys matching booking:slot:{studio}:{date}:*
      // Each key is "booking:slot:curve:2025-06-15:10:00" → time = "10:00"
      const keys = await kv('KEYS', `booking:slot:${studio}:${date}:*`);

      bookedSlots[studio] = (keys || []).map(k => {
        // Key format: booking:slot:{studio}:{date}:{HH}:{MM}
        const parts = k.split(':');
        // Extract time portion: parts[4] = HH, parts[5] = MM
        return parts.slice(4).join(':');
      });
    }

    return res.status(200).json({ bookedSlots, date });

  } catch (err) {
    console.error('[check-availability]', err.message);
    // Return empty availability on error — do not block the user
    const fallback = {};
    studioList.forEach(s => { fallback[s] = []; });
    return res.status(200).json({ bookedSlots: fallback, date, degraded: true });
  }
}
