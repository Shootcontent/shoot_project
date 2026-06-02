/**
 * GET  /api/admin/coupons  — list all coupons
 * POST /api/admin/coupons  — create a new coupon
 */

import { requireSession } from '../_admin-auth.js';
import { listCoupons, createCoupon } from '../_coupon.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  // ── GET — list ────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const coupons = await listCoupons();
      return res.status(200).json({ coupons });
    } catch (err) {
      console.error('[admin/coupons GET]', err);
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST — create ─────────────────────────────────────────────────────────
  if (req.method === 'POST') {
    try {
      const { code, type, value, maxUses, expiresAt, description, customerEmail } = req.body || {};
      if (!code) return res.status(400).json({ error: 'code is required.' });
      if (!type) return res.status(400).json({ error: 'type is required (percent or fixed).' });
      if (!value) return res.status(400).json({ error: 'value is required.' });

      const coupon = await createCoupon({ code, type, value: parseFloat(value), maxUses: parseInt(maxUses, 10) || 0, expiresAt: expiresAt || '', description: description || '', customerEmail: customerEmail || '' });
      return res.status(201).json({ coupon });
    } catch (err) {
      console.error('[admin/coupons POST]', err);
      return res.status(400).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
