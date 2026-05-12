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
    lazyConnect:          true,
    maxRetriesPerRequest: 3,
    connectTimeout:       8000,
    // Only use TLS for rediss:// URLs — Redis Cloud port 14xxx is plain TCP
    tls: url.startsWith('rediss://') ? { rejectUnauthorized: false } : undefined,
  });

  client.on('error', err => console.error('[kv] Redis error:', err.message));

  _clientPromise = client.connect().then(() => client);
  return _clientPromise;
}

/**
 * kv('SET', 'key', 'val', 'NX', 'EX', '900') → 'OK' | null
 * kv('GET', 'key')                            → string | null
 * kv('DEL', 'key')                            → number
 * kv('KEYS', 'pattern:*')                     → string[]
 */
export async function kv(command, ...args) {
  const client = await getClient();
  return client.call(command, ...args);
}

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
