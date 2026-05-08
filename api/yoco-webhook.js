// api/yoco-webhook.js — authoritative payment confirmation path

const crypto = require('crypto');
const { confirmBooking } = require('./verify-payment');
const { releaseSlots, redis } = require('./_redis');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readBody(req);

  const secret = process.env.YOCO_WEBHOOK_SECRET;
  if (secret) {
    const sig      = req.headers['x-yoco-signature'] || '';
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!safeEqual(sig, expected)) {
      console.warn('[webhook] Invalid signature');
      return res.status(401).json({ error: 'Invalid signature' });
    }
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).end(); }

  console.log('[webhook]', event.type, '| id:', event.id);

  const bookingId = event.payload?.metadata?.bookingId;

  if (event.type === 'payment.succeeded' && bookingId) {
    const alreadyDone = await redis('GET', `confirmed:${bookingId}`);
    if (!alreadyDone) await confirmBooking(bookingId, event.payload?.id || event.id);
  }

  if (event.type === 'payment.failed' && bookingId) {
    const raw2 = await redis('GET', `booking:${bookingId}`);
    if (raw2) {
      const booking = JSON.parse(raw2);
      if (booking.slotKeys?.length) await releaseSlots(booking.slotKeys);
    }
  }

  return res.status(200).json({ received: true });
};

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', c => chunks.push(c));
    req.on('end',  () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function safeEqual(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(a, 'hex'), Buffer.from(b, 'hex')); }
  catch { return false; }
}
