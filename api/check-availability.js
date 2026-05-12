/**
 * GET /api/check-availability?date=YYYY-MM-DD&studios=curve,studio1,pool
 *
 * Returns booked time intervals for the requested studios on a given date.
 * The frontend uses these intervals — combined with the user's chosen duration —
 * to disable time slots that would cause an overlap.
 *
 * Response shape:
 *   {
 *     date: "2026-05-13",
 *     intervals: {
 *       curve:   [{ start: "09:00", end: "11:00" }, ...],
 *       studio1: [],
 *       pool:    [{ start: "14:00", end: "19:00" }]
 *     }
 *   }
 *
 * Stale pending intervals (whose booking:pending key expired) are pruned lazily.
 */

import { kv } from './_kv.js';

const VALID_STUDIOS = new Set(['curve', 'studio1', 'pool']);
const DATE_RE       = /^\d{4}-\d{2}-\d{2}$/;

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  // Never cache — availability data must always be live
  res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
  res.setHeader('Pragma', 'no-cache');
}

/** minutes-since-midnight → "HH:MM" */
function minsToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

/**
 * Reads all valid intervals from booking:intervals:{studio}:{date}.
 * Expired pending entries are cleaned up in the background.
 */
async function getIntervals(studio, date) {
  const hashKey = `booking:intervals:${studio}:${date}`;
  const raw = await kv('HGETALL', hashKey);
  if (!raw) return [];

  const valid = [];
  const stale = [];
  const debugEntries = [];

  for (const [field, val] of Object.entries(raw)) {
    if (!val || !val.includes(':')) continue;
    const [startMins, endMins] = val.split(':').map(Number);
    if (isNaN(startMins) || isNaN(endMins)) continue;

    if (field.startsWith('p:')) {
      const bId = field.slice(2);
      const stillPending = await kv('GET', `booking:pending:${bId}`);
      debugEntries.push({ field, bId, stillPending: !!stillPending, raw: stillPending?.slice?.(0,20) });
      if (!stillPending) { stale.push(field); continue; }
    }
    valid.push({ start: minsToTime(startMins), end: minsToTime(endMins) });
  }

  if (stale.length) kv('HDEL', hashKey, ...stale).catch(() => {});
  return { valid, debugEntries };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const { date, studios } = req.query;

  if (!date || !DATE_RE.test(date)) {
    return res.status(400).json({ error: 'Invalid or missing date. Use YYYY-MM-DD.' });
  }

  const today = new Date().toISOString().split('T')[0];
  if (date < today) {
    return res.status(400).json({ error: 'Cannot check availability for past dates.' });
  }

  const studioList = (studios || '')
    .split(',')
    .map(s => s.trim().toLowerCase())
    .filter(s => VALID_STUDIOS.has(s));

  if (studioList.length === 0) {
    return res.status(400).json({ error: 'Provide at least one valid studio.' });
  }

  try {
    const result = {};
    const debug = {};
    for (const studio of studioList) {
      const { valid, debugEntries } = await getIntervals(studio, date);
      result[studio] = valid;
      debug[studio] = debugEntries;
    }
    return res.status(200).json({ date, intervals: result, _debug: debug });

  } catch (err) {
    console.error('[check-availability]', err.message);
    const fallback = {};
    studioList.forEach(s => { fallback[s] = []; });
    return res.status(200).json({ date, intervals: fallback, degraded: true });
  }
}
