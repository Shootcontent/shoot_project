// api/yoco-webhook.js — Yoco webhook handler (logs events, email sent via verify-payment polling)

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readBody(req);

  const secret = process.env.YOCO_WEBHOOK_SECRET;
  if (secret) {
    const sig      = req.headers['x-yoco-signature'] || '';
    const expected = crypto.createHmac('sha256', secret).update(raw).digest('hex');
    if (!safeEqual(sig, expected)) {
      console.warn('[webhook] Invalid signature');
      return res.status(401).end();
    }
  }

  let event;
  try { event = JSON.parse(raw.toString('utf8')); }
  catch { return res.status(400).end(); }

  console.log('[webhook] event:', event.type, '| checkout:', event.payload?.metadata?.bookingId || '—');
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
