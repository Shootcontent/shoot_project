/**
 * _slot-block.js — Admin slot blocking helpers
 *
 * Blocks integrate with the existing slot system by writing `b:{blockId}`
 * entries into booking:intervals:{studio}:{date}. Because check-availability.js
 * and create-checkout.js only prune `p:` (pending) entries, block entries
 * are treated as permanently occupied — no existing files need modification.
 *
 * Redis structures:
 *   slot:block:{blockId}               HASH { studio, date, time, scope, startMins, endMins, reason, blockedBy, blockedAt }
 *   slot:idx:blocks:{studio}:{date}    SET  { blockId, ... }
 *   booking:intervals:{studio}:{date}  HASH  b:{blockId} → "{startMins}:{endMins}"   ← plugs into existing system
 *   booking:slot:{studio}:{date}:{time} → "blocked:{blockId}"   ← belt-and-suspenders for exact-time
 */

import { kv, kvHGetAll } from './_kv.js';

const DURATION_MINS = { '90min': 90, '2hrs': 120, '3hrs': 180, halfday: 300, fullday: 600 };

function genBlockId() {
  return `BLK-${Date.now().toString(36).toUpperCase()}-${Math.random().toString(36).slice(2, 5).toUpperCase()}`;
}

export function timeToMins(t) {
  const [h, m] = (t || '00:00').split(':').map(Number);
  return h * 60 + m;
}

export function minsToTime(m) {
  return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}`;
}

function overlaps(s1, e1, s2, e2) { return s1 < e2 && e1 > s2; }

/** Acquire the write lock for a studio/date. Returns lockKey or null on failure. */
async function acquireLock(studio, date, holder) {
  const lockKey = `booking:lock:${studio}:${date}`;
  const ok = await kv('SET', lockKey, holder, 'NX', 'EX', '15');
  return ok === 'OK' ? lockKey : null;
}
async function releaseLock(key) { await kv('DEL', key).catch(() => {}); }

/**
 * Create a slot block.
 * scope: 'full_day' | 'time_slot'
 * For full_day: blocks the entire day (0–1440 mins)
 * For time_slot: blocks a specific time + duration
 */
export async function createBlock({ studio, date, time, duration, scope, reason, blockedBy }) {
  if (!['curve', 'studio1', 'pool'].includes(studio)) throw new Error('Invalid studio.');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('Invalid date.');
  if (!['full_day', 'time_slot'].includes(scope)) throw new Error('scope must be full_day or time_slot.');

  let startMins, endMins;
  if (scope === 'full_day') {
    startMins = 0; endMins = 1440;
  } else {
    if (!time || !/^\d{2}:\d{2}$/.test(time)) throw new Error('time required for time_slot blocks.');
    if (!duration || !DURATION_MINS[duration]) throw new Error('Invalid duration.');
    startMins = timeToMins(time);
    endMins   = startMins + DURATION_MINS[duration];
  }

  // Acquire lock to prevent race with create-checkout
  const lockKey = await acquireLock(studio, date, `block-${Date.now()}`);
  if (!lockKey) throw new Error('Studio is busy (booking in progress). Retry in a moment.');

  try {
    // Warn if conflicting with a confirmed booking (check c: entries in interval hash)
    const hashKey = `booking:intervals:${studio}:${date}`;
    const raw     = await kvHGetAll(hashKey);
    const confirmedConflicts = [];
    if (raw) {
      for (const [field, val] of Object.entries(raw)) {
        if (!field.startsWith('c:')) continue;
        const [s, e] = val.split(':').map(Number);
        if (overlaps(startMins, endMins, s, e)) {
          confirmedConflicts.push({ bookingId: field.slice(2), time: minsToTime(s) });
        }
      }
    }

    const blockId   = genBlockId();
    const blockedAt = new Date().toISOString();

    // Store block metadata
    await kv('HSET', `slot:block:${blockId}`,
      'studio',     studio,
      'date',       date,
      'time',       time || '',
      'duration',   duration || '',
      'scope',      scope,
      'startMins',  String(startMins),
      'endMins',    String(endMins),
      'reason',     reason || '',
      'blockedBy',  blockedBy,
      'blockedAt',  blockedAt,
    );

    // Plug into existing availability system
    await kv('HSET', hashKey, `b:${blockId}`, `${startMins}:${endMins}`);

    // Exact-time slot key (belt-and-suspenders, only for time_slot)
    if (scope === 'time_slot' && time) {
      await kv('SET', `booking:slot:${studio}:${date}:${time}`, `blocked:${blockId}`, 'NX');
    }

    // Index
    await kv('SADD', `slot:idx:blocks:${studio}:${date}`, blockId);
    await kv('SADD', 'slot:idx:all-blocks', blockId);

    return { blockId, studio, date, time, scope, startMins, endMins, reason, blockedBy, blockedAt, confirmedConflicts };
  } finally {
    await releaseLock(lockKey);
  }
}

/** Remove a slot block, restoring public availability. */
export async function removeBlock(blockId, removedBy) {
  const raw = await kvHGetAll(`slot:block:${blockId}`);
  if (!raw || !raw.studio) throw new Error('Block not found.');

  const { studio, date, time, scope } = raw;

  const lockKey = await acquireLock(studio, date, `unblock-${Date.now()}`);
  if (!lockKey) throw new Error('Studio is busy. Retry in a moment.');

  try {
    // Remove from intervals hash (restores public availability immediately)
    await kv('HDEL', `booking:intervals:${studio}:${date}`, `b:${blockId}`);

    // Remove slot key only if it still points to this block
    if (scope === 'time_slot' && time) {
      const slotVal = await kv('GET', `booking:slot:${studio}:${date}:${time}`);
      if (slotVal === `blocked:${blockId}`) {
        await kv('DEL', `booking:slot:${studio}:${date}:${time}`);
      }
    }

    // Cleanup indexes and metadata
    await kv('SREM', `slot:idx:blocks:${studio}:${date}`, blockId);
    await kv('SREM', 'slot:idx:all-blocks', blockId);
    await kv('DEL', `slot:block:${blockId}`);

    return { ok: true, studio, date };
  } finally {
    await releaseLock(lockKey);
  }
}

/** List all blocks for a studio+date */
export async function listBlocksForDate(studio, date) {
  const ids = await kv('SMEMBERS', `slot:idx:blocks:${studio}:${date}`);
  if (!ids || ids.length === 0) return [];
  const blocks = await Promise.all(ids.map(id => getBlock(id)));
  return blocks.filter(Boolean).sort((a, b) => a.startMins - b.startMins);
}

/** List all blocks across all studios (recent) */
export async function listAllBlocks() {
  const ids = await kv('SMEMBERS', 'slot:idx:all-blocks');
  if (!ids || ids.length === 0) return [];
  const blocks = await Promise.all(ids.map(id => getBlock(id)));
  return blocks.filter(Boolean).sort((a, b) => b.blockedAt > a.blockedAt ? 1 : -1);
}

export async function getBlock(blockId) {
  const raw = await kvHGetAll(`slot:block:${blockId}`);
  if (!raw || !raw.studio) return null;
  return {
    blockId,
    studio:    raw.studio,
    date:      raw.date,
    time:      raw.time || null,
    duration:  raw.duration || null,
    scope:     raw.scope,
    startMins: parseInt(raw.startMins, 10),
    endMins:   parseInt(raw.endMins, 10),
    startTime: minsToTime(parseInt(raw.startMins, 10)),
    endTime:   minsToTime(parseInt(raw.endMins, 10)),
    reason:    raw.reason || '',
    blockedBy: raw.blockedBy,
    blockedAt: raw.blockedAt,
  };
}
