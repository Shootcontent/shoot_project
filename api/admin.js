/**
 * Admin utility endpoint — protected by ADMIN_SECRET env var.
 *
 * GET  /api/admin?secret=XXX&action=list        — list all confirmed bookings
 * POST /api/admin?secret=XXX&action=flush       — delete ALL booking data (test reset)
 * GET  /api/admin?secret=XXX&action=test-email  — send a test email via Brevo
 */

import { kv } from './_kv.js';

const BREVO_API_URL = 'https://api.brevo.com/v3/smtp/email';

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
}

function auth(req, res) {
  const secret = process.env.ADMIN_SECRET;
  if (!secret) {
    res.status(500).json({ error: 'ADMIN_SECRET env var not set.' });
    return false;
  }
  if (req.query.secret !== secret) {
    res.status(401).json({ error: 'Unauthorized.' });
    return false;
  }
  return true;
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (!auth(req, res)) return;

  const action = req.query.action;

  // ── LIST all confirmed bookings ────────────────────────────────────────────
  if (action === 'list') {
    try {
      const keys = await kv('KEYS', 'booking:record:*');
      if (!keys || keys.length === 0) {
        return res.status(200).json({ bookings: [], count: 0 });
      }
      const records = await Promise.all(
        keys.map(async k => {
          const raw = await kv('GET', k);
          try { return JSON.parse(raw); } catch { return null; }
        })
      );
      const bookings = records
        .filter(Boolean)
        .sort((a, b) => (a.date > b.date ? 1 : a.date < b.date ? -1 : 0));
      return res.status(200).json({ bookings, count: bookings.length });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── FLUSH all booking/slot data ────────────────────────────────────────────
  if (action === 'flush') {
    if (req.method !== 'POST') {
      return res.status(405).json({ error: 'Use POST for flush.' });
    }
    try {
      const patterns = [
        'booking:slot:*',
        'booking:intervals:*',
        'booking:pending:*',
        'booking:record:*',
        'booking:lock:*',
        'checkout:*',
      ];
      let deleted = 0;
      for (const pattern of patterns) {
        const keys = await kv('KEYS', pattern);
        if (keys && keys.length > 0) {
          await kv('DEL', ...keys);
          deleted += keys.length;
        }
      }
      return res.status(200).json({ success: true, deletedKeys: deleted });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── TEST EMAIL via Brevo ───────────────────────────────────────────────────
  if (action === 'test-email') {
    const apiKey = process.env.BREVO_API_KEY;
    const from   = process.env.FROM_EMAIL || 'hello@shootstudios.co.za';

    if (!apiKey) {
      return res.status(500).json({ error: 'BREVO_API_KEY is not set in environment variables.' });
    }

    try {
      const r = await fetch(BREVO_API_URL, {
        method:  'POST',
        headers: { 'api-key': apiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sender:      { name: 'SHOOT. Studios', email: from },
          to:          [{ email: 'hello@shootstudios.co.za' }],
          subject:     'SHOOT. — Test Email',
          textContent: 'If you received this, Brevo email is working correctly.',
        }),
      });
      const body = await r.json();
      if (r.ok) {
        return res.status(200).json({ success: true, brevo: body });
      } else {
        return res.status(200).json({ success: false, status: r.status, brevo: body });
      }
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(400).json({ error: 'Unknown action. Use: list, flush (POST), test-email' });
}
