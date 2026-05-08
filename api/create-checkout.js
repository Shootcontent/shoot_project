// api/create-checkout.js
// Creates a Yoco hosted checkout session server-side.
// The secret key never leaves this function — the frontend only receives
// a redirectUrl which is safe to expose.

const { createClient } = require('@supabase/supabase-js');

const YOCO_API     = 'https://payments.yoco.com/api/checkouts';
const SITE_URL     = process.env.SITE_URL || 'https://www.shootstudios.co.za';
const ALLOWED_ORIGIN = SITE_URL;

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST')   return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId, lockToken, amountRands } = req.body || {};

  if (!bookingId || !lockToken || amountRands === undefined)
    return res.status(400).json({ error: 'Missing bookingId, lockToken or amountRands' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Verify lock is still valid ──────────────────────────────────────────────
  const { data: lock, error: lockErr } = await supabase
    .from('slot_locks')
    .select('id, expires_at, status')
    .eq('lock_token',  lockToken)
    .eq('booking_id',  bookingId)
    .eq('status',      'active')
    .gt('expires_at',  new Date().toISOString())
    .maybeSingle();

  if (lockErr || !lock) {
    return res.status(409).json({
      error: 'Slot hold expired — please restart your booking',
      expired: true,
    });
  }

  const amountCents = Math.round(Number(amountRands) * 100);
  if (amountCents < 100) {
    return res.status(400).json({ error: 'Amount too small (minimum R1.00)' });
  }

  // ── Create Yoco checkout ────────────────────────────────────────────────────
  let checkout;
  try {
    const yocoRes = await fetch(YOCO_API, {
      method:  'POST',
      headers: {
        'Content-Type':  'application/json',
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
        'Idempotency-Key': bookingId,   // prevents duplicate charges on retry
      },
      body: JSON.stringify({
        amount:     amountCents,
        currency:   'ZAR',
        successUrl: `${SITE_URL}/booking-success.html?bookingId=${bookingId}&lockToken=${lockToken}`,
        cancelUrl:  `${SITE_URL}/booking-cancel.html?bookingId=${bookingId}&lockToken=${lockToken}&reason=cancelled`,
        failureUrl: `${SITE_URL}/booking-cancel.html?bookingId=${bookingId}&lockToken=${lockToken}&reason=failed`,
        metadata: {
          bookingId,
          lockToken,
          source: 'shoot_studios',
        },
      }),
    });

    if (!yocoRes.ok) {
      const body = await yocoRes.text();
      console.error('[create-checkout] Yoco error:', yocoRes.status, body);
      return res.status(502).json({ error: 'Payment provider error — please try again' });
    }

    checkout = await yocoRes.json();
  } catch (err) {
    console.error('[create-checkout] fetch error:', err);
    return res.status(502).json({ error: 'Could not reach payment provider' });
  }

  // ── Update booking with Yoco checkout ID ────────────────────────────────────
  await supabase
    .from('bookings')
    .update({ yoco_checkout_id: checkout.id, status: 'locked' })
    .eq('id', bookingId);

  return res.status(200).json({
    checkoutId:  checkout.id,
    redirectUrl: checkout.redirectUrl,
  });
};
