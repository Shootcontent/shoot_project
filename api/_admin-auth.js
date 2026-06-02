/**
 * _admin-auth.js
 *
 * Shared admin session utilities.
 * Used by every /api/admin/* handler to protect routes.
 *
 * Redis structures:
 *   admin:session:{token}   STRING  JSON { username, createdAt }  TTL=86400 (24h)
 *   admin:rate:login:{ip}   STRING  count  TTL=900 (15-min window, max 10 attempts)
 */

import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import { kv } from './_kv.js';

const SESSION_TTL   = 60 * 60 * 24;      // 24 hours
const RATE_WINDOW   = 60 * 15;            // 15 minutes
const RATE_MAX      = 10;                 // max login attempts per window
const COOKIE_NAME   = '__shoot_admin';

// ── Session cookie ────────────────────────────────────────────────────────────

/** Serialises an HttpOnly session cookie value */
export function buildCookieHeader(token, clear = false) {
  if (clear) {
    return `${COOKIE_NAME}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }
  return `${COOKIE_NAME}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${SESSION_TTL}`;
}

/** Parses the session token out of the Cookie header */
function parseToken(req) {
  const raw = req.headers['cookie'] || '';
  for (const part of raw.split(';')) {
    const [k, v] = part.trim().split('=');
    if (k === COOKIE_NAME) return v;
  }
  return null;
}

// ── Session CRUD ──────────────────────────────────────────────────────────────

export async function createSession(username) {
  const token = crypto.randomBytes(48).toString('hex');
  await kv('SET', `admin:session:${token}`, JSON.stringify({ username, createdAt: new Date().toISOString() }), 'EX', String(SESSION_TTL));
  return token;
}

export async function destroySession(token) {
  if (token) await kv('DEL', `admin:session:${token}`).catch(() => {});
}

// ── Route guard ───────────────────────────────────────────────────────────────

/**
 * Call at the top of any admin handler.
 * Returns { username } on success, or sends 401 and returns null.
 */
export async function requireSession(req, res) {
  const token = parseToken(req);
  if (!token) {
    res.status(401).json({ error: 'Unauthorised.' });
    return null;
  }
  const raw = await kv('GET', `admin:session:${token}`);
  if (!raw) {
    res.status(401).json({ error: 'Session expired. Please log in again.' });
    return null;
  }
  try {
    return JSON.parse(raw);
  } catch {
    res.status(401).json({ error: 'Invalid session.' });
    return null;
  }
}

// ── Rate limiting ─────────────────────────────────────────────────────────────

/** Returns true if this IP is over the login attempt limit. */
export async function isRateLimited(ip) {
  const key   = `admin:rate:login:${ip}`;
  const count = await kv('INCR', key);
  if (count === 1) await kv('EXPIRE', key, String(RATE_WINDOW));
  return count > RATE_MAX;
}

// ── Password helpers ──────────────────────────────────────────────────────────

export async function verifyPassword(plain, hash) {
  return bcrypt.compare(plain, hash);
}

/**
 * Utility: generate a bcrypt hash for initial setup.
 * Call once from CLI: node -e "import('./_admin-auth.js').then(m=>m.hashPassword('yourpw').then(console.log))"
 */
export async function hashPassword(plain) {
  return bcrypt.hash(plain, 12);
}
