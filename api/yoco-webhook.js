// api/yoco-webhook.js
// Receives Yoco payment events. No database — just logs and acknowledges.
// Webhook URL to set in Yoco dashboard: https://www.shootstudios.co.za/api/yoco-webhook

const crypto = require('crypto');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const raw = await readBody(req);

  // Verify HMAC signature if webhook secret is configured
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
  catch { return res.status(400).json({ error: 'Invalid JSON' }); }

  console.log('[webhook] Event received:', event.type, '| id:', event.id);
  console.log('[webhook] Payload:', JSON.stringify(event.payload?.metadata || {}));

  // Acknowledge immediately — Yoco retries if we don't respond 200
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
