/**
 * GET  /api/admin/booking?id=BK-xxx  — fetch single booking
 * PATCH /api/admin/booking?id=BK-xxx — update notes field only
 */

import { requireSession } from '../_admin-auth.js';
import { kv } from '../_kv.js';

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = {
  '90min': '90 minutes', '2hrs': '2 hours', '3hrs': '3 hours',
  halfday: 'Half day (5hrs)', fullday: 'Full day (10hrs)',
};
const ADDON_LABELS = { sunset: 'Sunset Package', snoot: 'Snoot', mic: 'Microphone', rgb: 'RGB Lighting' };

function normalize(b) {
  const cents = b.amountPaid ?? b.amountCents ?? 0;
  return {
    bookingId:      b.bookingId,
    studios:        b.studios || [],
    studiosLabel:   (b.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + '),
    duration:       b.duration,
    durationLabel:  DUR_LABELS[b.duration] || b.duration,
    extraHours:     b.extraHours || 0,
    date:           b.date,
    time:           b.time,
    firstName:      b.firstName,
    lastName:       b.lastName,
    email:          b.email,
    phone:          b.phone,
    photo:          b.photo || 'none',
    addons:         (b.addons || []).map(a => ADDON_LABELS[a] || a),
    cameraBody:     b.cameraBody || null,
    rentalDuration: b.rentalDuration || null,
    lensChoice:     b.lensChoice || null,
    discountCode:   b.discountCode || null,
    amountCents:    cents,
    amountRands:    Math.round(cents) / 100,
    transactionId:  b.transactionId || null,
    paymentStatus:  b.paymentStatus || 'paid',
    bookingStatus:  b.bookingStatus || 'confirmed',
    createdAt:      b.createdAt || b.confirmedAt || null,
    notes:          b.notes || '',
  };
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  const { id } = req.query;
  if (!id || !/^BK-/.test(id)) {
    return res.status(400).json({ error: 'Invalid booking ID.' });
  }

  const key = `booking:record:${id}`;

  // ── GET ───────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const raw = await kv('GET', key);
      if (!raw) return res.status(404).json({ error: 'Booking not found.' });
      return res.status(200).json(normalize(JSON.parse(raw)));
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── PATCH (notes only) ────────────────────────────────────────────────────
  if (req.method === 'PATCH') {
    try {
      const raw = await kv('GET', key);
      if (!raw) return res.status(404).json({ error: 'Booking not found.' });
      const booking = JSON.parse(raw);

      const { notes } = req.body || {};
      if (typeof notes === 'string') booking.notes = notes.slice(0, 1000);

      const ttl = await kv('TTL', key);
      const ex  = ttl > 0 ? ttl : 60 * 60 * 24 * 730;
      await kv('SET', key, JSON.stringify(booking), 'EX', String(ex));
      return res.status(200).json({ ok: true });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
