/**
 * Redis helper using ioredis — works with Redis Cloud (redis:// URLs).
 * Env var: REDIS_URL  e.g. redis://default:password@host:port
 */

import Redis from 'ioredis';

let _clientPromise = null;

async function getClient() {
  if (_clientPromise) return _clientPromise;

  const url = process.env.REDIS_URL;
  if (!url) throw new Error('REDIS_URL is not configured');

  const client = new Redis(url, {
    lazyConnect:         true,
    maxRetriesPerRequest: 3,
    connectTimeout:      8000,
    // Redis Cloud requires TLS even on redis:// URLs
    tls: url.includes('redislabs.com') ? { rejectUnauthorized: false } : undefined,
  });

  client.on('error', err => console.error('[kv] Redis error:', err.message));

  _clientPromise = client.connect().then(() => client);
  return _clientPromise;
}

/**
 * Execute a single Redis command.
 * kv('SET', 'key', 'val', 'NX', 'EX', '900') → 'OK' | null
 * kv('GET', 'key')                            → string | null
 * kv('DEL', 'key')                            → number
 * kv('KEYS', 'pattern:*')                     → string[]
 */
export async function kv(command, ...args) {
  const client = await getClient();
  return client.call(command, ...args);
}

/**
 * Execute multiple commands in a single pipeline round-trip.
 */
export async function kvPipeline(commands) {
  const client = await getClient();
  const pipeline = client.pipeline();
  for (const [command, ...args] of commands) {
    pipeline.call(command, ...args);
  }
  const results = await pipeline.exec();
  return results.map(([err, result]) => {
    if (err) throw err;
    return result;
  });
}
