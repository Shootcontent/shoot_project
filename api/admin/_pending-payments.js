/**
 * GET /api/admin/pending-payments
 * Returns all payment requests with their quote details.
 */

import { requireSession } from '../_admin-auth.js';
import { listPaymentRequests, getQuote } from '../_admin-booking.js';

const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed.' });

  const session = await requireSession(req, res);
  if (!session) return;

  try {
    const requests = await listPaymentRequests();

    const enriched = await Promise.all(requests.map(async r => {
      const quote = await getQuote(r.quoteId);
      return {
        ...r,
        quote: quote ? {
          quoteId:     quote.quoteId,
          studios:     (quote.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + '),
          date:        quote.date,
          time:        quote.time,
          name:        `${quote.firstName} ${quote.lastName}`,
          email:       quote.email,
          amountRands: (r.amountCents || 0) / 100,
        } : null,
      };
    }));

    // Group by status
    const pending   = enriched.filter(r => r.status === 'pending');
    const paid      = enriched.filter(r => r.status === 'paid');
    const expired   = enriched.filter(r => r.status === 'expired');
    const cancelled = enriched.filter(r => r.status === 'cancelled');

    return res.status(200).json({ requests: enriched, pending, paid, expired, cancelled });
  } catch (err) {
    console.error('[pending-payments]', err);
    return res.status(500).json({ error: err.message });
  }
}
