/**
 * Redis helper using ioredis — works with standard redis:// URLs (Redis Cloud).
 * Env var: REDIS_URL  e.g. redis://default:password@host:port
 */

import Redis from 'ioredis';

// Reuse connection across warm lambda invocations
let _client = null;

function getClient() {
  if (!_client || _client.status === 'end' || _client.status === 'close') {
    if (!process.env.REDIS_URL) throw new Error('REDIS_URL is not configured');
    const url = process.env.REDIS_URL;
    _client = new Redis(url, {
      maxRetriesPerRequest: 3,
      connectTimeout:       5000,
      enableOfflineQueue:   false,
      // Redis Cloud (redislabs.com) requires TLS even when the URL uses redis://
      tls: url.includes('redislabs.com') ? { rejectUnauthorized: false } : undefined,
    });
    _client.on('error', err => console.error('[kv] Redis error:', err.message));
  }
  return _client;
}

/**
 * Execute a single Redis command.
 * kv('SET', 'key', 'val', 'NX', 'EX', '900') → 'OK' | null
 * kv('GET', 'key')                            → string | null
 * kv('DEL', 'key')                            → number
 * kv('KEYS', 'pattern:*')                     → string[]
 */
export async function kv(command, ...args) {
  return getClient().call(command, ...args);
}

/**
 * Execute multiple commands in a single pipeline round-trip.
 */
export async function kvPipeline(commands) {
  const pipeline = getClient().pipeline();
  for (const [command, ...args] of commands) {
    pipeline.call(command, ...args);
  }
  const results = await pipeline.exec();
  return results.map(([err, result]) => {
    if (err) throw err;
    return result;
  });
}
