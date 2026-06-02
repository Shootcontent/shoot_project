/**
 * GET  /api/admin/quotes  — list all quotes
 * POST /api/admin/quotes  — create a new draft quote
 */

import { requireSession } from '../_admin-auth.js';
import { createQuote, listQuotes } from '../_admin-booking.js';
import { auditLog } from '../_audit.js';

const VALID_STUDIOS   = new Set(['curve', 'studio1', 'pool']);
const VALID_DURATIONS = new Set(['90min', '2hrs', '3hrs', 'halfday', 'fullday']);
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const TIME_RE = /^\d{2}:\d{2}$/;
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();

  const session = await requireSession(req, res);
  if (!session) return;

  // ── GET ───────────────────────────────────────────────────────────────────────
  if (req.method === 'GET') {
    try {
      const quotes = await listQuotes();
      return res.status(200).json({ quotes });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  // ── POST — create quote ───────────────────────────────────────────────────────
  if (req.method === 'POST') {
    const body = req.body || {};
    const { studios, duration, extraHours, date, time, firstName, lastName, email, phone, customPriceCents, discountCode, clientNotes, notes } = body;

    if (!Array.isArray(studios) || !studios.length || studios.some(s => !VALID_STUDIOS.has(s)))
      return res.status(400).json({ error: 'Invalid studio selection.' });
    if (!VALID_DURATIONS.has(duration))
      return res.status(400).json({ error: 'Invalid duration.' });
    if (!date || !DATE_RE.test(date))
      return res.status(400).json({ error: 'Invalid date.' });
    if (!time || !TIME_RE.test(time))
      return res.status(400).json({ error: 'Invalid time.' });
    if (!firstName?.trim() || !lastName?.trim())
      return res.status(400).json({ error: 'First and last name required.' });
    if (!email || !EMAIL_RE.test(email))
      return res.status(400).json({ error: 'Valid email required.' });
    if (!phone?.trim())
      return res.status(400).json({ error: 'Phone number required.' });
    if (!customPriceCents || parseInt(customPriceCents, 10) <= 0)
      return res.status(400).json({ error: 'Price must be greater than 0.' });

    try {
      const quote = await createQuote({
        studios,
        duration,
        extraHours: parseInt(extraHours, 10) || 0,
        date,
        time,
        firstName: firstName.trim(),
        lastName:  lastName.trim(),
        email:     email.toLowerCase().trim(),
        phone:     phone.trim(),
        customPriceCents: parseInt(customPriceCents, 10),
        discountCode: discountCode || null,
        clientNotes: clientNotes || '',
        notes:     notes || '',
        createdBy: session.username,
      });
      auditLog(session.username, 'quote.create', 'quote', quote.quoteId, { studios, date, time, email });
      return res.status(201).json({ quote });
    } catch (err) {
      return res.status(500).json({ error: err.message });
    }
  }

  return res.status(405).json({ error: 'Method not allowed.' });
}
