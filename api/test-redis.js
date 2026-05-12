/**
 * Temporary diagnostic — tests Redis with and without TLS.
 * GET /api/test-redis
 */
import Redis from 'ioredis';

async function tryConnect(url, useTLS) {
  const client = new Redis(url, {
    lazyConnect:          true,
    maxRetriesPerRequest: 1,
    connectTimeout:       6000,
    tls: useTLS ? { rejectUnauthorized: false, checkServerIdentity: () => undefined } : undefined,
  });
  try {
    await client.connect();
    const ping = await client.ping();
    await client.quit();
    return { ok: true, tls: useTLS, ping };
  } catch (err) {
    await client.quit().catch(() => {});
    return { ok: false, tls: useTLS, error: err.message };
  }
}

export default async function handler(req, res) {
  const url = process.env.REDIS_URL;
  if (!url) return res.status(500).json({ error: 'REDIS_URL not set' });

  const [withTLS, withoutTLS] = await Promise.all([
    tryConnect(url, true),
    tryConnect(url, false),
  ]);

  return res.status(200).json({ withTLS, withoutTLS });
}
