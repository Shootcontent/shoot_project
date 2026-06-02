import { kv } from './_kv.js';
import { couponKey, getCoupon } from './_coupon.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { code } = req.body || {};
  if (!code) return res.status(400).end();

  const normalCode = code.toUpperCase().trim();

  try {
    const coupon = await getCoupon(normalCode);
    if (coupon) {
      await kv('HINCRBY', couponKey(normalCode), 'currentUses', '1');
    }
    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[redeem-discount]', err);
    return res.status(500).json({ ok: false });
  }
}
