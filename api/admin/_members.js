/**
 * GET  /api/admin/members  — list all members
 * POST /api/admin/members  — manually create a member (admin override)
 */

import { requireSession } from '../_admin-auth.js';
import { listMembers, createMember, getFoundingStats } from '../_member.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  // ── GET — list ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const [members, founding] = await Promise.all([listMembers(), getFoundingStats()]);
      return res.status(200).json({ members, founding });
    } catch (err) {
      console.error('[admin/members GET]', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST — create ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { email, firstName, lastName, phone, pricePaidCents, note } = req.body || {};
      if (!email) return res.status(400).json({ error: 'email is required.' });
      if (!firstName || !lastName) return res.status(400).json({ error: 'firstName and lastName are required.' });

      const member = await createMember({
        email,
        firstName,
        lastName,
        phone: phone || '',
        pricePaidCents: parseInt(pricePaidCents, 10) || undefined,
        note: note || 'Created manually by admin',
      });
      return res.status(201).json({ member });
    } catch (err) {
      console.error('[admin/members POST]', err);
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
