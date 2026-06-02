/**
 * GET /api/admin/bookings
 *
 * Query params:
 *   page=1, limit=25
 *   search=  (matches bookingId, name, email)
 *   studio=  (curve|studio1|pool)
 *   from=    YYYY-MM-DD
 *   to=      YYYY-MM-DD
 */

import { requireSession } from '../_admin-auth.js';
import { kv } from '../_kv.js';

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day', fullday: 'Full day' };

function normalize(b) {
  const cents = b.amountPaid ?? b.amountCents ?? 0;
  return {
    bookingId:   b.bookingId,
    studios:     b.studios || [],
    studiosLabel:(b.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + '),
    duration:    DUR_LABELS[b.duration] || b.duration,
    date:        b.date,
    time:        b.time,
    firstName:   b.firstName,
    lastName:    b.lastName,
    name:        `${b.firstName || ''} ${b.lastName || ''}`.trim() || b.email,
    email:       b.email,
    phone:       b.phone,
    amountRands: Math.round(cents) / 100,
    status:      b.bookingStatus || 'confirmed',
    createdAt:   b.createdAt || b.confirmedAt || null,
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const session = await requireSession(req, res);
  if (!session) return;

  try {
    const keys = await kv('KEYS', 'booking:record:*');
    if (!keys || keys.length === 0) {
      return res.status(200).json({ bookings: [], total: 0, page: 1, pages: 0 });
    }

    const records = await Promise.all(
      keys.map(async k => {
        const raw = await kv('GET', k);
        try { return JSON.parse(raw); } catch { return null; }
      })
    );

    let bookings = records.filter(Boolean).map(normalize);

    // ── Filters ──────────────────────────────────────────────────────────────
    const { search = '', studio = '', from = '', to = '', status = '' } = req.query;

    if (search) {
      const q = search.toLowerCase();
      bookings = bookings.filter(b =>
        (b.bookingId || '').toLowerCase().includes(q) ||
        (b.name || '').toLowerCase().includes(q) ||
        (b.email || '').toLowerCase().includes(q) ||
        (b.phone || '').toLowerCase().includes(q)
      );
    }
    if (studio) {
      bookings = bookings.filter(b => (b.studios || []).includes(studio));
    }
    if (status) {
      bookings = bookings.filter(b => b.status === status);
    }
    if (from) bookings = bookings.filter(b => b.date >= from);
    if (to)   bookings = bookings.filter(b => b.date <= to);

    // ── Sort by date desc ─────────────────────────────────────────────────────
    bookings.sort((a, b) => {
      if (b.date !== a.date) return b.date > a.date ? 1 : -1;
      return (b.time || '') > (a.time || '') ? 1 : -1;
    });

    // ── Paginate ──────────────────────────────────────────────────────────────
    const limit = Math.min(100, Math.max(1, parseInt(req.query.limit, 10) || 25));
    const page  = Math.max(1, parseInt(req.query.page, 10) || 1);
    const total = bookings.length;
    const pages = Math.ceil(total / limit);
    const slice = bookings.slice((page - 1) * limit, page * limit);

    return res.status(200).json({ bookings: slice, total, page, pages, limit });
  } catch (err) {
    console.error('[admin/bookings]', err);
    return res.status(500).json({ error: err.message });
  }
}
