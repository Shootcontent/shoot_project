// api/yoco-webhook.js
// Receives payment events from Yoco and updates booking status.
// This is the authoritative confirmation path — verify-payment.js is the fallback.
//
// Configure in Yoco dashboard:
//   Webhook URL: https://www.shootstudios.co.za/api/yoco-webhook
//   Events: payment.succeeded, payment.failed

const crypto = require('crypto');
const { createClient } = require('@supabase/supabase-js');

// Disable body parsing so we can verify the raw HMAC signature
module.exports.config = { api: { bodyParser: false } };

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  // ── Read raw body ───────────────────────────────────────────────────────────
  const rawBody = await readRawBody(req);

  // ── Verify Yoco HMAC signature ──────────────────────────────────────────────
  const webhookSecret = process.env.YOCO_WEBHOOK_SECRET;
  if (webhookSecret) {
    const signature = req.headers['x-yoco-signature'] || req.headers['webhook-signature'] || '';
    const expected  = crypto
      .createHmac('sha256', webhookSecret)
      .update(rawBody)
      .digest('hex');

    if (!timingSafeEqual(signature, expected)) {
      console.warn('[yoco-webhook] Invalid signature — request rejected');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  } else {
    console.warn('[yoco-webhook] YOCO_WEBHOOK_SECRET not set — signature check skipped (set it in production!)');
  }

  // ── Parse event ─────────────────────────────────────────────────────────────
  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    return res.status(400).json({ error: 'Invalid JSON' });
  }

  console.log('[yoco-webhook] Received event:', event.type, event.id);

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── payment.succeeded ───────────────────────────────────────────────────────
  if (event.type === 'payment.succeeded') {
    const payload    = event.payload || {};
    const { bookingId, lockToken } = payload.metadata || {};

    if (!bookingId) {
      console.warn('[yoco-webhook] payment.succeeded missing bookingId in metadata');
      return res.status(200).json({ received: true });
    }

    // Confirm booking
    const { error } = await supabase
      .from('bookings')
      .update({
        status:          'confirmed',
        yoco_payment_id: payload.id,
        confirmed_at:    new Date().toISOString(),
      })
      .eq('id', bookingId)
      .in('status', ['pending', 'locked']);  // idempotent — only update if not already confirmed

    if (error) {
      console.error('[yoco-webhook] Failed to confirm booking:', error);
      return res.status(500).json({ error: 'DB error' });
    }

    // Confirm the slot lock
    await supabase
      .from('slot_locks')
      .update({ status: 'confirmed' })
      .eq('booking_id', bookingId)
      .eq('status',     'active');

    // TODO: Send confirmation email to customer here using Resend / SendGrid
    // See docs/email-setup.md

    console.log('[yoco-webhook] Booking confirmed:', bookingId);
    return res.status(200).json({ received: true });
  }

  // ── payment.failed ──────────────────────────────────────────────────────────
  if (event.type === 'payment.failed') {
    const { bookingId } = event.payload?.metadata || {};

    if (bookingId) {
      await supabase
        .from('bookings')
        .update({ status: 'failed' })
        .eq('id', bookingId)
        .in('status', ['pending', 'locked']);

      await supabase
        .from('slot_locks')
        .update({ status: 'released' })
        .eq('booking_id', bookingId)
        .eq('status',     'active');

      console.log('[yoco-webhook] Booking failed, slot released:', bookingId);
    }

    return res.status(200).json({ received: true });
  }

  // Unknown event type — acknowledge so Yoco doesn't retry
  return res.status(200).json({ received: true, note: 'Unhandled event type' });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function readRawBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end',  ()    => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function timingSafeEqual(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex'));
  } catch {
    return false;
  }
}
