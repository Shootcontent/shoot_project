/**
 * POST /api/admin/login
 *
 * Body: { username, password }
 *
 * Validates credentials against ADMIN_USERNAME + ADMIN_PASSWORD_HASH env vars,
 * rate-limits by IP, and issues a session cookie on success.
 */

import { isRateLimited, verifyPassword, createSession, buildCookieHeader } from '../_admin-auth.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'same-origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';

  // ── Rate limit ─────────────────────────────────────────────────────────────
  if (await isRateLimited(ip)) {
    return res.status(429).json({ error: 'Too many login attempts. Try again in 15 minutes.' });
  }

  const { username, password } = req.body || {};

  if (!username || !password) {
    return res.status(400).json({ error: 'Username and password are required.' });
  }

  // ── Validate credentials ───────────────────────────────────────────────────
  const expectedUser = process.env.ADMIN_USERNAME;
  const expectedHash = process.env.ADMIN_PASSWORD_HASH;

  if (!expectedUser || !expectedHash) {
    console.error('[admin/login] ADMIN_USERNAME or ADMIN_PASSWORD_HASH env vars not set.');
    return res.status(500).json({ error: 'Admin authentication is not configured.' });
  }

  const usernameMatch = username === expectedUser;
  // Always run bcrypt compare to prevent timing attacks even on username mismatch
  const passwordMatch = await verifyPassword(password, expectedHash);

  if (!usernameMatch || !passwordMatch) {
    return res.status(401).json({ error: 'Invalid credentials.' });
  }

  // ── Create session ─────────────────────────────────────────────────────────
  const token = await createSession(username);
  res.setHeader('Set-Cookie', buildCookieHeader(token));

  return res.status(200).json({ ok: true, username });
}
