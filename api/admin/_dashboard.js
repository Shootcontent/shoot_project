/**
 * GET /api/admin/dashboard
 * Returns overview stats for the admin dashboard with date filtering.
 *
 * Query params:
 *   from=YYYY-MM-DD  (defaults to start of current month)
 *   to=YYYY-MM-DD    (defaults to today)
 */

import { requireSession } from '../_admin-auth.js';
import { kv } from '../_kv.js';
import { listQuotes } from '../_admin-booking.js';

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day', fullday: 'Full day' };

function normalize(b) {
  const cents = b.amountPaid ?? b.amountCents ?? 0;
  return {
    bookingId:   b.bookingId,
    studios:     (b.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + '),
    duration:    DUR_LABELS[b.duration] || b.duration,
    date:        b.date,
    time:        b.time,
    name:        `${b.firstName || ''} ${b.lastName || ''}`.trim() || b.email,
    email:       b.email,
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
    const todayStr   = new Date().toLocaleDateString('en-CA', { timeZone: 'Africa/Johannesburg' });
    const monthStart = todayStr.slice(0, 8) + '01';
    const from = req.query.from || monthStart;
    const to   = req.query.to   || todayStr;

    // Load all booking records
    const keys = await kv('KEYS', 'booking:record:*');
    let allBookings = [];
    if (keys && keys.length > 0) {
      const records = await Promise.all(
        keys.map(async k => {
          const raw = await kv('GET', k);
          try { return JSON.parse(raw); } catch { return null; }
        })
      );
      allBookings = records.filter(Boolean);
    }

    // All-time totals
    const allTotal   = allBookings.length;
    const allRevenue = allBookings.reduce((sum, b) => sum + Math.round(b.amountPaid ?? b.amountCents ?? 0) / 100, 0);

    // Date-range filtered bookings (filter by session/booking date)
    const filtered = allBookings.filter(b => b.date >= from && b.date <= to);

    const totalBookings   = filtered.length;
    const totalRevenue    = filtered.reduce((sum, b) => sum + Math.round(b.amountPaid ?? b.amountCents ?? 0) / 100, 0);
    const confirmedCount  = filtered.filter(b => !b.bookingStatus || b.bookingStatus === 'confirmed').length;
    const cancelledCount  = filtered.filter(b => b.bookingStatus === 'cancelled').length;
    const avgBookingValue = totalBookings > 0 ? Math.round((totalRevenue / totalBookings) * 100) / 100 : 0;

    // Live quote counts (not date-filtered — always current)
    const quotes = await listQuotes();
    const pendingPaymentCount = quotes.filter(q => q.status === 'pending_payment').length;
    const draftCount          = quotes.filter(q => q.status === 'draft').length;

    // Recent bookings within the selected range
    const recent = filtered
      .sort((a, b) => {
        const dc = b.date > a.date ? 1 : b.date < a.date ? -1 : 0;
        if (dc !== 0) return dc;
        return (b.createdAt || b.confirmedAt || '') > (a.createdAt || a.confirmedAt || '') ? 1 : -1;
      })
      .slice(0, 10)
      .map(normalize);

    return res.status(200).json({
      from, to,
      allTotal,
      allRevenue:        Math.round(allRevenue * 100) / 100,
      totalBookings,
      totalRevenue:      Math.round(totalRevenue * 100) / 100,
      confirmedCount,
      cancelledCount,
      avgBookingValue,
      pendingPaymentCount,
      draftCount,
      recent,
    });
  } catch (err) {
    console.error('[admin/dashboard]', err);
    return res.status(500).json({ error: err.message });
  }
}
