import { getCoupon } from './_coupon.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ valid: false, message: 'Email and code are required.' });
  }

  const normalCode = code.toUpperCase().trim();
  const addr       = email.toLowerCase().trim();

  try {
    const coupon = await getCoupon(normalCode);

    if (!coupon) {
      return res.status(200).json({ valid: false, message: 'Invalid discount code.' });
    }
    if (!coupon.active) {
      return res.status(200).json({ valid: false, message: 'This discount code is no longer active.' });
    }
    if (coupon.expiresAt && new Date(coupon.expiresAt) < new Date()) {
      return res.status(200).json({ valid: false, message: 'This discount code has expired.' });
    }
    if (coupon.maxUses > 0 && coupon.currentUses >= coupon.maxUses) {
      return res.status(200).json({ valid: false, message: 'This discount code has been fully redeemed.' });
    }
    if (coupon.customerEmail && coupon.customerEmail.toLowerCase() !== addr) {
      return res.status(200).json({ valid: false, message: 'This discount code is not valid for your email address.' });
    }

    const label = coupon.type === 'percent'
      ? `${coupon.value}% off`
      : `R${coupon.value} off`;

    return res.status(200).json({
      valid:         true,
      discount:      coupon.type === 'percent' ? coupon.value : 0,
      discountType:  coupon.type,
      discountFixed: coupon.type === 'fixed' ? coupon.value : 0,
      code:          normalCode,
      message:       `${normalCode} — ${label} applied.`,
    });

  } catch (err) {
    console.error('[validate-discount]', err);
    return res.status(500).json({ valid: false, message: 'Validation failed. Please try again.' });
  }
}
