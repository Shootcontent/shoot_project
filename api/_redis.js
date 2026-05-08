// api/_redis.js — Upstash Redis REST helpers (underscore = not a Vercel route)

const BASE  = () => process.env.UPSTASH_REDIS_REST_URL;
const TOKEN = () => process.env.UPSTASH_REDIS_REST_TOKEN;

function headers() {
  return { 'Authorization': `Bearer ${TOKEN()}`, 'Content-Type': 'application/json' };
}

// Single command: redis('SET','key','value','EX','600')
async function redis(...args) {
  const res  = await fetch(BASE(), { method: 'POST', headers: headers(), body: JSON.stringify(args) });
  const data = await res.json();
  if (data.error) throw new Error(`Redis error: ${data.error}`);
  return data.result;
}

// Pipeline: redisPipeline([['SET','k','v'],['GET','k2']])
async function redisPipeline(cmds) {
  const res  = await fetch(`${BASE()}/pipeline`, { method: 'POST', headers: headers(), body: JSON.stringify(cmds) });
  const data = await res.json();
  return data; // array of {result, error}
}

// Generate every 30-min slot key a booking occupies
function slotKeys(studios, date, startTime, durationHrs) {
  const keys = [];
  const [h, m] = startTime.split(':').map(Number);
  const startMins = h * 60 + m;
  const slots     = Math.ceil(durationHrs * 2); // 30-min increments
  for (let i = 0; i < slots; i++) {
    const t    = startMins + i * 30;
    const str  = `${String(Math.floor(t/60)).padStart(2,'0')}${String(t%60).padStart(2,'0')}`;
    for (const s of studios) keys.push(`slot:${s}:${date}:${str}`);
  }
  return keys;
}

// Atomically lock all slot keys (SET NX EX). Returns true on success.
// On partial failure rolls back already-set keys.
async function acquireLocks(keys, value, ttlSeconds) {
  const cmds    = keys.map(k => ['SET', k, value, 'NX', 'EX', String(ttlSeconds)]);
  const results = await redisPipeline(cmds);
  const allOk   = results.every(r => r.result === 'OK');
  if (!allOk) {
    const toDelete = keys.filter((_, i) => results[i].result === 'OK');
    if (toDelete.length) await redisPipeline(toDelete.map(k => ['DEL', k]));
    return false;
  }
  return true;
}

// Confirm slot keys (make permanent — remove TTL)
async function confirmSlots(keys, bookingId) {
  const cmds = keys.map(k => ['SET', k, `confirmed:${bookingId}`]);
  await redisPipeline(cmds);
}

// Release slot keys (delete)
async function releaseSlots(keys) {
  if (!keys.length) return;
  await redisPipeline(keys.map(k => ['DEL', k]));
}

module.exports = { redis, redisPipeline, slotKeys, acquireLocks, confirmSlots, releaseSlots };
