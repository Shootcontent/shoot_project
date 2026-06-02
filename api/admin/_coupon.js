/**
 * GET    /api/admin/coupon?code=XXX  — fetch single coupon
 * PATCH  /api/admin/coupon?code=XXX  — update coupon
 * DELETE /api/admin/coupon?code=XXX  — delete coupon
 */

import { requireSession } from '../_admin-auth.js';
import { getCoupon, updateCoupon, deleteCoupon } from '../_coupon.js';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  const { code } = req.query;
  if (!code) return res.status(400).json({ error: 'code query param is required.' });

  if (req.method === 'GET') {
    try {
      const coupon = await getCoupon(code);
      if (!coupon) return res.status(404).json({ error: 'Coupon not found.' });
      return res.status(200).json({ coupon });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  if (req.method === 'PATCH') {
    try {
      const coupon = await updateCoupon(code, req.body || {});
      return res.status(200).json({ coupon });
    } catch (err) {
      return res.status(err.message === 'Coupon not found.' ? 404 : 400).json({ error: err.message });
    }
  }

  if (req.method === 'DELETE') {
    try {
      await deleteCoupon(code);
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
