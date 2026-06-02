/**
 * POST /api/admin/logout
 *
 * Deletes the session from Redis and clears the session cookie.
 */

import { destroySession, buildCookieHeader } from '../_admin-auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const raw    = req.headers['cookie'] || '';
  const cookie = raw.split(';').map(s => s.trim()).find(s => s.startsWith('__shoot_admin='));
  const token  = cookie ? cookie.split('=')[1] : null;

  await destroySession(token);

  res.setHeader('Set-Cookie', buildCookieHeader(null, true));
  return res.status(200).json({ ok: true });
}
