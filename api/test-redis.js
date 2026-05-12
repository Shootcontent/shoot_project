/**
 * Temporary diagnostic endpoint — remove after confirming Redis works.
 * GET /api/test-redis
 */
import Redis from 'ioredis';

export default async function handler(req, res) {
  const url = process.env.REDIS_URL;
  if (!url) return res.status(500).json({ error: 'REDIS_URL not set' });

  const safe = url.replace(/:([^@]{4})[^@]*@/, ':$1***@');

  try {
    const client = new Redis(url, {
      lazyConnect:         true,
      maxRetriesPerRequest: 1,
      connectTimeout:      8000,
      tls: url.includes('redislabs.com') ? { rejectUnauthorized: false } : undefined,
    });
    await client.connect();
    await client.set('ping-test', 'ok', 'EX', '60');
    const val = await client.get('ping-test');
    await client.quit();
    return res.status(200).json({ ok: true, ping: val, url: safe });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, url: safe });
  }
}
