const BREVO_API_KEY          = process.env.BREVO_API_KEY;
const BREVO_LIST_ID          = parseInt(process.env.BREVO_LIST_ID || '2', 10);
const FROM_EMAIL             = process.env.FROM_EMAIL || 'hello@shootstudios.co.za';
const FROM_NAME              = 'SHOOT. Studios';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

async function brevo(path, method = 'GET', body) {
  const r = await fetch(`https://api.brevo.com/v3${path}`, {
    method,
    headers: { 'api-key': BREVO_API_KEY, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: r.status, data: r.status === 204 ? null : await r.json() };
}

async function sendWelcomeEmail(email) {
  const html = `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Welcome to SHOOT.</title></head>
<body style="margin:0;padding:0;background:#0a0a0a;font-family:'Helvetica Neue',Helvetica,Arial,sans-serif;-webkit-font-smoothing:antialiased;">
  <table width="100%" cellpadding="0" cellspacing="0" border="0">
    <tr><td align="center" style="padding:48px 24px 64px;">
      <table width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:520px;">
        <tr><td>
          <p style="margin:0 0 52px;font-size:10px;font-weight:700;letter-spacing:3.5px;text-transform:uppercase;color:rgba(255,255,255,0.3);">SHOOT. Photographic Studios</p>
          <h1 style="margin:0 0 20px;font-size:42px;font-weight:900;font-style:italic;color:#ffffff;line-height:1;letter-spacing:-1.5px;">Welcome.</h1>
          <p style="margin:0 0 40px;font-size:15px;line-height:1.75;color:rgba(255,255,255,0.55);">You're on the list. As a first-time client,<br>use the code below for 10% off your first session.</p>
          <table width="100%" cellpadding="0" cellspacing="0" border="0" style="margin:0 0 40px;border:1px solid rgba(255,255,255,0.12);">
            <tr><td align="center" style="padding:28px 32px;">
              <p style="margin:0 0 10px;font-size:9px;font-weight:700;letter-spacing:3px;text-transform:uppercase;color:rgba(255,255,255,0.3);">Your discount code</p>
              <p style="margin:0;font-size:30px;font-weight:900;letter-spacing:6px;color:#ffffff;">SHOOT10</p>
            </td></tr>
          </table>
          <p style="margin:0 0 48px;font-size:12px;line-height:1.7;color:rgba(255,255,255,0.35);">Enter this code at checkout. Valid for one use only — on your first studio booking.</p>
          <a href="https://shootstudios.co.za" style="display:inline-block;border:1px solid rgba(255,255,255,0.35);color:#ffffff;padding:13px 40px;font-size:10px;font-weight:700;letter-spacing:2.5px;text-transform:uppercase;text-decoration:none;">Book a Session</a>
          <p style="margin:52px 0 0;font-size:10px;color:rgba(255,255,255,0.18);letter-spacing:0.5px;">SHOOT. Photographic Studios &nbsp;·&nbsp; 135 Albert Rd, Woodstock, Cape Town</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body></html>`;

  return brevo('/smtp/email', 'POST', {
    sender: { name: FROM_NAME, email: FROM_EMAIL },
    to: [{ email }],
    subject: 'Welcome to SHOOT. — your exclusive code inside',
    htmlContent: html,
  });
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  const { email, _trap } = req.body || {};

  // Honeypot — bots fill hidden fields
  if (_trap) return res.status(200).json({ status: 'ok' });

  // Basic format check
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const addr = email.toLowerCase().trim();

  try {
    // Check for existing contact
    const existing = await brevo(`/contacts/${encodeURIComponent(addr)}`);

    if (existing.status === 200) {
      return res.status(200).json({
        status: 'existing',
        message: "You're already part of the SHOOT mailing list.",
      });
    }

    if (existing.status !== 404) {
      throw new Error(`Brevo lookup returned ${existing.status}`);
    }

    // New contact — add to list
    const created = await brevo('/contacts', 'POST', {
      email: addr,
      listIds: [BREVO_LIST_ID],
      updateEnabled: false,
    });

    // Handle race-condition duplicate (code 'duplicate_parameter')
    if (created.status === 400 && created.data?.code === 'duplicate_parameter') {
      return res.status(200).json({
        status: 'existing',
        message: "You're already part of the SHOOT mailing list.",
      });
    }

    if (created.status !== 201) {
      throw new Error(`Brevo create returned ${created.status}: ${JSON.stringify(created.data)}`);
    }

    // Fire and forget — welcome email
    sendWelcomeEmail(addr).catch(err => console.error('Welcome email failed:', err));

    return res.status(200).json({ status: 'success' });

  } catch (err) {
    console.error('[newsletter]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
