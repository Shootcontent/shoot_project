/**
 * GET /api/get-config
 * Returns non-sensitive client configuration.
 * Secret keys are NEVER returned here — only the public Yoco key.
 */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  const publicKey = process.env.YOCO_PUBLIC_KEY;
  if (!publicKey) {
    console.error('[get-config] YOCO_PUBLIC_KEY not set');
    return res.status(500).json({ error: 'Payment not configured' });
  }

  return res.status(200).json({ yocoPublicKey: publicKey });
}
