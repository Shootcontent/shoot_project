/**
 * GET /api/admin/audit?limit=50
 * Returns the most recent admin audit log entries.
 */

import { requireSession } from '../_admin-auth.js';
import { getAuditLog } from '../_audit.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const session = await requireSession(req, res);
  if (!session) return;

  try {
    const limit   = Math.min(200, Math.max(1, parseInt(req.query.limit, 10) || 50));
    const entries = await getAuditLog(limit);
    return res.status(200).json({ entries, count: entries.length });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
