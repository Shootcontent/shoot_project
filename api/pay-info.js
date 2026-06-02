/**
 * GET /api/pay-info?token={token}
 * PUBLIC endpoint — returns payment request details for a customer payment page.
 * Never returns internal admin data, notes, or other booking IDs.
 */

import { getPaymentRequest, getQuote } from './_admin-booking.js';

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS   = { '90min': '90 min', '2hrs': '2 hrs', '3hrs': '3 hrs', halfday: 'Half day (5 hrs)', fullday: 'Full day (10 hrs)' };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'same-origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Cache-Control', 'no-store');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const { token } = req.query;
  if (!token || token.length < 60) return res.status(400).json({ error: 'Invalid token.' });

  try {
    const payReq = await getPaymentRequest(token);
    if (!payReq) return res.status(404).json({ error: 'Payment link not found or expired.' });
    if (payReq.status === 'expired')  return res.status(410).json({ error: 'This payment link has expired. Please contact us to request a new one.' });
    if (payReq.status === 'paid')     return res.status(200).json({ status: 'paid', message: 'This booking has already been paid.' });
    if (payReq.status === 'cancelled') return res.status(410).json({ error: 'This payment link has been cancelled. Please contact us.' });

    const quote = await getQuote(payReq.quoteId);
    if (!quote) return res.status(404).json({ error: 'Booking details not found.' });

    // Return only what the customer needs — no internal data
    return res.status(200).json({
      status:        payReq.status,
      expiresAt:     payReq.expiresAt,
      amountCents:   payReq.amountCents,
      amountRands:   payReq.amountCents / 100,
      studios:       (quote.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + '),
      date:          quote.date,
      time:          quote.time,
      duration:      DUR_LABELS[quote.duration] || quote.duration,
      firstName:     quote.firstName,
      lastName:      quote.lastName,
    });
  } catch (err) {
    console.error('[pay-info]', err);
    return res.status(500).json({ error: 'Something went wrong. Please contact us.' });
  }
}
