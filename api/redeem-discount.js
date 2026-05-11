const BREVO_API_KEY          = process.env.BREVO_API_KEY;
const BREVO_REDEEMED_LIST_ID = parseInt(process.env.BREVO_REDEEMED_LIST_ID || '3', 10);

const VALID_CODES = new Set(['SHOOT10']);

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, code } = req.body || {};
  if (!email || !code) return res.status(400).end();

  const addr       = email.toLowerCase().trim();
  const normalCode = code.toUpperCase().trim();

  if (!VALID_CODES.has(normalCode)) return res.status(200).json({ ok: true }); // ignore unknown codes

  try {
    // Add email to redeemed list (creates contact if not exists via updateEnabled)
    await fetch('https://api.brevo.com/v3/contacts', {
      method: 'POST',
      headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: addr,
        listIds: [BREVO_REDEEMED_LIST_ID],
        updateEnabled: true, // add to list even if contact already exists
      }),
    });

    return res.status(200).json({ ok: true });
  } catch (err) {
    console.error('[redeem-discount]', err);
    return res.status(500).json({ ok: false });
  }
}
