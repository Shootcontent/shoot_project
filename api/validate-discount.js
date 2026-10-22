import { getCoupon } from './_coupon.js';
import { getMemberByCode, getMemberByEmail, getRemainingCap } from './_member.js';
import { getMemberRate } from './_member-discount.js';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, code, date, time } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ valid: false, message: 'Email and code are required.' });
  }

  const normalCode = code.toUpperCase().trim();
  const addr       = email.toLowerCase().trim();

  try {
    // ── Check if it's a member code ──────────────────────────────────────────
    const member = await getMemberByCode(normalCode);
    if (member) {
      // Verify email matches
      if (member.email !== addr) {
        return res.status(200).json({ valid: false, message: 'This member code does not match your email address.' });
      }
      // Check active + not expired
      if (member.status !== 'active') {
        return res.status(200).json({ valid: false, message: 'This membership is no longer active.' });
      }
      if (member.expiresAt && new Date(member.expiresAt) < new Date()) {
        return res.status(200).json({ valid: false, message: 'This membership has expired.' });
      }
      // Get rate for the selected date/time
      const { rate, label } = getMemberRate(date, time);
      const remainingCapCents = await getRemainingCap(member.memberId);

      return res.status(200).json({
        valid:            true,
        isMember:         true,
        memberCode:       normalCode,
        memberId:         member.memberId,
        memberTier:       member.tier,
        memberRate:       rate,
        memberRateLabel:  label,
        remainingCapCents,
        firstName:        member.firstName || '',
        lastName:         member.lastName || '',
        phone:            member.phone || '',
        memberEmail:      member.email || '',
        code:             normalCode,
        message:          rate > 0
          ? `SHOOT. Club — ${label}. Savings cap: R${(remainingCapCents / 100).toFixed(0)} remaining.`
          : `SHOOT. Club member verified — ${label}.`,
      });
    }

    // ── Regular coupon lookup ────────────────────────────────────────────────
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
