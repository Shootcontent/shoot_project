/**
 * Temporary diagnostic endpoint — remove after confirming Redis works.
 * GET /api/test-redis
 */
import Redis from 'ioredis';

export default async function handler(req, res) {
  const url = process.env.REDIS_URL;
  if (!url) return res.status(500).json({ error: 'REDIS_URL not set' });

  // Mask password in URL for safe logging
  const safe = url.replace(/:([^@]+)@/, ':***@');

  try {
    const client = new Redis(url, {
      maxRetriesPerRequest: 1,
      connectTimeout: 5000,
      enableOfflineQueue: false,
      tls: url.includes('redislabs.com') ? { rejectUnauthorized: false } : undefined,
    });
    await client.set('ping-test', 'ok', 'EX', '60');
    const val = await client.get('ping-test');
    await client.quit();
    return res.status(200).json({ ok: true, ping: val, url: safe });
  } catch (err) {
    return res.status(500).json({ ok: false, error: err.message, url: safe });
  }
}
