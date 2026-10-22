/**
 * GET    /api/admin/member?id=SC-001  — fetch single member + savings history
 * PATCH  /api/admin/member?id=SC-001  — update member fields
 * DELETE /api/admin/member?id=SC-001  — delete member
 */

import { requireSession } from '../_admin-auth.js';
import { getMember, updateMember, deleteMember, getSavingsHistory, getRemainingCap } from '../_member.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id query param is required.' });

  if (req.method === 'GET') {
    try {
      const member = await getMember(id);
      if (!member) return res.status(404).json({ error: 'Member not found.' });
      const [savings, remainingCap] = await Promise.all([
        getSavingsHistory(id),
        getRemainingCap(id),
      ]);
      return res.status(200).json({ member, savings, remainingCapCents: remainingCap });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const member = await updateMember(id, req.body || {});
      return res.status(200).json({ member });
    } catch (err) {
      return res.status(err.message === 'Member not found.' ? 404 : 400).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteMember(id);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
