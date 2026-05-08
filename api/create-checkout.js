// api/create-checkout.js — creates Yoco checkout, stores booking details in metadata for email

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

  const { bookingId, lockToken, amountRands, bookingData } = req.body || {};
  if (!bookingId || !lockToken || amountRands === undefined) {
    return res.status(400).json({ error: 'Missing required fields' });
  }

  const amountCents = Math.round(Number(amountRands) * 100);
  if (amountCents < 200) return res.status(400).json({ error: 'Amount too small (min R2.00)' });

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
        metadata: {
          bookingId,
          lockToken,
          firstName:   bookingData?.firstName   || '',
          lastName:    bookingData?.lastName    || '',
          email:       bookingData?.email       || '',
          phone:       bookingData?.phone       || '',
          studios:     (bookingData?.studios    || []).join(','),
          date:        bookingData?.date        || '',
          startTime:   bookingData?.startTime   || '',
          durationKey: bookingData?.durationKey || '',
          extraHours:  String(bookingData?.extraHours || 0),
          totalRands:  String(amountRands),
        },
      }),
    });

    if (!yocoRes.ok) {
      const err = await yocoRes.text();
      console.error('[create-checkout] Yoco error:', yocoRes.status, err);
      return res.status(502).json({ error: `Payment provider error: ${err}` });
    }

    const checkout = await yocoRes.json();
    console.log('[create-checkout] Created:', checkout.id, 'bookingId:', bookingId);
    return res.status(200).json({ checkoutId: checkout.id, redirectUrl: checkout.redirectUrl });

  } catch (err) {
    console.error('[create-checkout] failed:', err.message);
    return res.status(502).json({ error: 'Could not reach Yoco — try again' });
  }
};
