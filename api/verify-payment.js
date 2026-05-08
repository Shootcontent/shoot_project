// api/verify-payment.js — queries Yoco for payment status, confirms booking + sends email

const { redis, confirmSlots } = require('./_redis');
const { sendConfirmationEmail } = require('./_email');

const YOCO_API = 'https://payments.yoco.com/api/checkouts';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { checkoutId } = req.query;
  if (!checkoutId) return res.status(400).json({ error: 'Missing checkoutId' });
  if (!process.env.YOCO_SECRET_KEY) return res.status(500).json({ error: 'Payment not configured — YOCO_SECRET_KEY missing' });

  // ── Ask Yoco for checkout status ─────────────────────────────────────────────
  let checkout;
  try {
    const r = await fetch(`${YOCO_API}/${checkoutId}`, {
      headers: { 'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}` },
    });
    if (!r.ok) return res.status(502).json({ error: 'Could not reach Yoco' });
    checkout = await r.json();
  } catch (err) {
    return res.status(502).json({ error: 'Network error verifying payment' });
  }

  const status = (checkout.status || '').toLowerCase();
  console.log('[verify-payment] checkoutId:', checkoutId, '| status:', status);

  // ── Payment succeeded ────────────────────────────────────────────────────────
  if (status === 'complete' || status === 'completed' || status === 'succeeded' || status === 'paid') {
    const bookingId = checkout.metadata?.bookingId;
    if (bookingId) {
      const alreadyDone = await redis('GET', `confirmed:${bookingId}`);
      if (!alreadyDone) await confirmBooking(bookingId, checkout.id);
    }
    return res.status(200).json({
      status:  'confirmed',
      booking: {
        checkoutId:  checkout.id,
        paymentId:   checkout.payments?.[0]?.id || checkout.id,
        amountRands: ((checkout.amount || 0) / 100).toFixed(2),
      },
    });
  }

  if (status === 'failed')                            return res.status(200).json({ status: 'failed' });
  if (status === 'cancelled' || status === 'expired') return res.status(200).json({ status: 'cancelled' });

  return res.status(200).json({ status: 'pending' });
};

// ── Confirm: make slots permanent + send email ────────────────────────────────
async function confirmBooking(bookingId, checkoutId) {
  try {
    const raw = await redis('GET', `booking:${bookingId}`);
    if (!raw) { console.warn('[confirm] booking record not found:', bookingId); return; }
    const booking = JSON.parse(raw);

    if (booking.slotKeys?.length) await confirmSlots(booking.slotKeys, bookingId);

    await redis('SET', `confirmed:${bookingId}`, checkoutId);
    await redis('SET', `booking:${bookingId}`, JSON.stringify({ ...booking, status: 'confirmed', confirmedAt: new Date().toISOString() }));

    await sendConfirmationEmail(booking);
  } catch (err) {
    console.error('[confirm] error:', err.message);
  }
}

module.exports.confirmBooking = confirmBooking;
