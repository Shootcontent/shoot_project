/**
 * GET /api/admin/me
 *
 * Returns the current session's username if authenticated, else 401.
 * Used by admin pages to check auth status on load.
 */

import { requireSession } from '../_admin-auth.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const session = await requireSession(req, res);
  if (!session) return; // requireSession already sent 401

  return res.status(200).json({ ok: true, username: session.username });
}
