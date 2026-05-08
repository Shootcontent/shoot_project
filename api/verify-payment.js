// api/verify-payment.js
// Queries Yoco directly for checkout status — no database needed.

const YOCO_API = 'https://payments.yoco.com/api/checkouts';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { checkoutId } = req.query;
  if (!checkoutId) return res.status(400).json({ error: 'Missing checkoutId' });

  if (!process.env.YOCO_SECRET_KEY) {
    return res.status(500).json({ error: 'YOCO_SECRET_KEY not configured' });
  }

  try {
    const yocoRes = await fetch(`${YOCO_API}/${checkoutId}`, {
      headers: { 'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}` },
    });

    if (!yocoRes.ok) {
      const errText = await yocoRes.text();
      console.error('[verify-payment] Yoco error:', yocoRes.status, errText);
      return res.status(502).json({ error: 'Could not verify with Yoco' });
    }

    const checkout = await yocoRes.json();
    console.log('[verify-payment] Checkout status:', checkout.id, checkout.status);

    // Yoco checkout statuses: pending | complete | cancelled | expired
    const status = (checkout.status || '').toLowerCase();

    if (status === 'complete' || status === 'completed' || status === 'succeeded' || status === 'paid') {
      // Pull the payment ID from the payments array if available
      const paymentId = checkout.payments?.[0]?.id || checkout.id;
      return res.status(200).json({
        status:  'confirmed',
        booking: {
          checkoutId:  checkout.id,
          paymentId,
          amountRands: ((checkout.amount || 0) / 100).toFixed(2),
          currency:    checkout.currency,
          metadata:    checkout.metadata || {},
        },
      });
    }

    if (status === 'failed')    return res.status(200).json({ status: 'failed' });
    if (status === 'cancelled') return res.status(200).json({ status: 'cancelled' });
    if (status === 'expired')   return res.status(200).json({ status: 'cancelled' });

    // Still pending
    return res.status(200).json({ status: 'pending' });

  } catch (err) {
    console.error('[verify-payment] fetch error:', err.message);
    return res.status(502).json({ error: 'Network error verifying payment' });
  }
};
