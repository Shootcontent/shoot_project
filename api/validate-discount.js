const BREVO_API_KEY          = process.env.BREVO_API_KEY;
const BREVO_REDEEMED_LIST_ID = parseInt(process.env.BREVO_REDEEMED_LIST_ID || '3', 10);

const CODES = { SHOOT10: 10 }; // code → discount percentage

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function getContact(email) {
  const r = await fetch(`https://api.brevo.com/v3/contacts/${encodeURIComponent(email)}`, {
    headers: { 'api-key': BREVO_API_KEY },
  });
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  const { email, code } = req.body || {};
  if (!email || !code) {
    return res.status(400).json({ valid: false, message: 'Email and code are required.' });
  }

  const addr         = email.toLowerCase().trim();
  const normalCode   = code.toUpperCase().trim();
  const discount     = CODES[normalCode];

  if (!discount) {
    return res.status(200).json({ valid: false, message: 'Invalid discount code.' });
  }

  try {
    const { status, data } = await getContact(addr);

    // Contact must exist (i.e. they signed up for the newsletter)
    if (status === 404) {
      return res.status(200).json({
        valid: false,
        message: 'This code is linked to newsletter sign-ups. Join the list to receive your code.',
      });
    }

    if (status !== 200) throw new Error(`Brevo returned ${status}`);

    // Check if already in the redeemed list
    const alreadyRedeemed = Array.isArray(data.listIds) && data.listIds.includes(BREVO_REDEEMED_LIST_ID);
    if (alreadyRedeemed) {
      return res.status(200).json({ valid: false, message: 'This discount has already been redeemed.' });
    }

    return res.status(200).json({
      valid: true,
      discount,
      code: normalCode,
      message: `${normalCode} — ${discount}% off applied.`,
    });

  } catch (err) {
    console.error('[validate-discount]', err);
    return res.status(500).json({ valid: false, message: 'Validation failed. Please try again.' });
  }
}
