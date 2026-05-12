/**
 * Vercel KV (Upstash Redis) REST API helper.
 * Uses the raw REST API via fetch — no npm package required.
 * Env vars: KV_REST_API_URL, KV_REST_API_TOKEN (auto-injected by Vercel KV).
 */

const KV_URL   = process.env.KV_REST_API_URL;
const KV_TOKEN = process.env.KV_REST_API_TOKEN;

/**
 * Execute a single Redis command.
 * kv('SET', 'key', 'val', 'NX', 'EX', '900') → 'OK' | null
 * kv('GET', 'key')                            → string | null
 * kv('DEL', 'key')                            → number
 * kv('KEYS', 'pattern:*')                     → string[]
 */
export async function kv(...args) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured (KV_REST_API_URL / KV_REST_API_TOKEN missing)');

  const res = await fetch(KV_URL, {
    method:  'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(args),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`KV HTTP ${res.status}: ${text}`);
  }

  const { result, error } = await res.json();
  if (error) throw new Error(`KV error: ${error}`);
  return result;
}

/**
 * Execute multiple commands in a single pipeline round-trip.
 * Returns an array of results in the same order.
 */
export async function kvPipeline(commands) {
  if (!KV_URL || !KV_TOKEN) throw new Error('KV not configured');

  const res = await fetch(`${KV_URL}/pipeline`, {
    method:  'POST',
    headers: { Authorization: `Bearer ${KV_TOKEN}`, 'Content-Type': 'application/json' },
    body:    JSON.stringify(commands),
  });

  if (!res.ok) throw new Error(`KV pipeline HTTP ${res.status}`);

  const items = await res.json();
  return items.map(({ result, error }) => {
    if (error) throw new Error(`KV pipeline error: ${error}`);
    return result;
  });
}
