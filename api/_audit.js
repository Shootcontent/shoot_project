/**
 * _audit.js — fire-and-forget audit log writer
 *
 * Stores the last 500 admin actions in a Redis list.
 * Key: audit:log:recent (LIST, newest first, capped at 500)
 */

import { kv } from './_kv.js';

/**
 * Log an admin action. Fire-and-forget — never throws.
 * @param {string} adminUsername
 * @param {string} action  e.g. 'block.create', 'quote.send-payment', 'coupon.delete'
 * @param {string} targetType  e.g. 'slot', 'quote', 'coupon', 'booking'
 * @param {string} targetId
 * @param {object} metadata  any extra fields
 */
export function auditLog(adminUsername, action, targetType, targetId, metadata = {}) {
  const entry = JSON.stringify({
    ts:          new Date().toISOString(),
    adminUsername,
    action,
    targetType,
    targetId:    String(targetId),
    metadata,
  });

  kv('LPUSH', 'audit:log:recent', entry)
    .then(() => kv('LTRIM', 'audit:log:recent', '0', '499'))
    .catch(err => console.error('[audit] write failed:', err.message));
}

/** Returns the most recent N audit entries (default 50) */
export async function getAuditLog(limit = 50) {
  const raw = await kv('LRANGE', 'audit:log:recent', '0', String(Math.min(limit, 500) - 1));
  if (!Array.isArray(raw)) return [];
  return raw.map(r => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
}
