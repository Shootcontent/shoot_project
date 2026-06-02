/**
 * block-slot.js
 *
 * Manually blocks a time range for a specific studio on a specific date.
 * Writes a confirmed-style interval into the booking:intervals hash so that
 * the overlap-detection logic in create-checkout.js will reject any booking
 * that overlaps with this range.
 *
 * Usage:
 *   REDIS_URL=redis://... node scripts/block-slot.js
 *
 * To REMOVE the block:
 *   REDIS_URL=redis://... node scripts/block-slot.js --remove
 */

import Redis from 'ioredis';

// ── Config — edit these if needed ─────────────────────────────────────────────
const STUDIO    = 'curve';
const DATE      = '2026-05-28';          // YYYY-MM-DD
const START     = '12:00';               // HH:MM
const END       = '15:00';               // HH:MM
const BLOCK_ID  = 'BLOCK-20260528-1200'; // unique field name in the hash
// ──────────────────────────────────────────────────────────────────────────────

function timeToMins(t) {
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

const startMins = timeToMins(START);
const endMins   = timeToMins(END);
const hashKey   = `booking:intervals:${STUDIO}:${DATE}`;
const field     = `c:${BLOCK_ID}`; // 'c:' prefix = confirmed (never pruned as stale)

const url = process.env.REDIS_URL;
if (!url) {
  console.error('ERROR: REDIS_URL environment variable is not set.');
  process.exit(1);
}

const client = new Redis(url, {
  lazyConnect:          true,
  maxRetriesPerRequest: 3,
  connectTimeout:       8000,
  tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
});

const removing = process.argv.includes('--remove');

try {
  await client.connect();

  if (removing) {
    const deleted = await client.hdel(hashKey, field);
    if (deleted) {
      console.log(`✓ Block removed: ${hashKey} → field "${field}"`);
    } else {
      console.log(`⚠ Field "${field}" not found in ${hashKey} — nothing to remove.`);
    }
  } else {
    await client.hset(hashKey, field, `${startMins}:${endMins}`);
    console.log(`✓ Slot blocked successfully.`);
    console.log(`  Hash key : ${hashKey}`);
    console.log(`  Field    : ${field}`);
    console.log(`  Value    : ${startMins}:${endMins}  (${START}–${END})`);
    console.log('');
    console.log(`  Bookings for The Curve on ${DATE} between ${START} and ${END}`);
    console.log(`  will now be rejected as unavailable.`);
    console.log('');
    console.log(`  To remove this block, run:`);
    console.log(`  REDIS_URL=... node scripts/block-slot.js --remove`);
  }

  // Verify by reading back the full hash
  const all = await client.hgetall(hashKey);
  console.log(`\n  Current intervals for ${hashKey}:`);
  if (!all || Object.keys(all).length === 0) {
    console.log('  (empty)');
  } else {
    for (const [f, v] of Object.entries(all)) {
      const [s, e] = v.split(':').map(Number);
      const sTime  = `${String(Math.floor(s/60)).padStart(2,'0')}:${String(s%60).padStart(2,'0')}`;
      const eTime  = `${String(Math.floor(e/60)).padStart(2,'0')}:${String(e%60).padStart(2,'0')}`;
      console.log(`    ${f.padEnd(35)} → ${sTime}–${eTime}`);
    }
  }

} catch (err) {
  console.error('ERROR:', err.message);
  process.exit(1);
} finally {
  await client.quit();
}
