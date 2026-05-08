// api/create-checkout.js
// Creates a Yoco hosted checkout — secret key stays server-side only.
// No database required. Only needs YOCO_SECRET_KEY env var.

const YOCO_API = 'https://payments.yoco.com/api/checkouts';

function getSiteUrl(req) {
  if (process.env.SITE_URL) return process.env.SITE_URL;
  if (process.env.VERCEL_URL) return `https://${process.env.VERCEL_URL}`;
  const proto = req.headers['x-forwarded-proto'] || 'https';
  const host  = req.headers['x-forwarded-host'] || req.headers.host || 'www.shootstudios.co.za';
  return `${proto}://${host}`;
}

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  if (!process.env.YOCO_SECRET_KEY) {
    return res.status(500).json({ error: 'Payment not configured — YOCO_SECRET_KEY missing' });
  }

  const { bookingId, lockToken, amountRands } = req.body || {};
  if (!bookingId || !lockToken || amountRands === undefined) {
    return res.status(400).json({ error: 'Missing bookingId, lockToken or amountRands' });
  }

  const amountCents = Math.round(Number(amountRands) * 100);
  if (amountCents < 100) return res.status(400).json({ error: 'Amount too small (min R1.00)' });

  const siteUrl = getSiteUrl(req);

  try {
    const yocoRes = await fetch(YOCO_API, {
      method:  'POST',
      headers: {
        'Content-Type':    'application/json',
        'Authorization':   `Bearer ${process.env.YOCO_SECRET_KEY}`,
        'Idempotency-Key': bookingId,
      },
      body: JSON.stringify({
        amount:     amountCents,
        currency:   'ZAR',
        successUrl: `${siteUrl}/booking-success.html`,
        cancelUrl:  `${siteUrl}/booking-cancel.html?reason=cancelled`,
        failureUrl: `${siteUrl}/booking-cancel.html?reason=failed`,
        metadata:   { bookingId, lockToken },
      }),
    });

    if (!yocoRes.ok) {
      const errText = await yocoRes.text();
      console.error('[create-checkout] Yoco error:', yocoRes.status, errText);
      return res.status(502).json({ error: `Payment provider error: ${errText}` });
    }

    const checkout = await yocoRes.json();
    console.log('[create-checkout] Created checkout:', checkout.id, 'for booking:', bookingId);

    return res.status(200).json({
      checkoutId:  checkout.id,
      redirectUrl: checkout.redirectUrl,
    });

  } catch (err) {
    console.error('[create-checkout] fetch failed:', err.message);
    return res.status(502).json({ error: 'Could not reach Yoco — check server logs' });
  }
};
