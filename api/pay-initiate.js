/**
 * POST /api/pay-initiate
 * PUBLIC endpoint — creates a Yoco hosted checkout for a payment request.
 * Called when the customer clicks "Pay Now" on the payment page.
 *
 * Body: { token }
 * Returns: { redirectUrl, quoteId }
 */

import { getPaymentRequest, getQuote, updatePaymentRequest } from './_admin-booking.js';

const YOCO_CHECKOUT_URL = 'https://payments.yoco.com/api/checkouts';
const STUDIO_NAMES = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', 'same-origin');
  res.setHeader('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Cache-Control', 'no-store');
}

export default async function handler(req, res) {
  setCors(res);
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const { token } = req.body || {};
  if (!token || token.length < 60) return res.status(400).json({ error: 'Invalid token.' });

  try {
    const payReq = await getPaymentRequest(token);
    if (!payReq || payReq.status === 'expired')
      return res.status(410).json({ error: 'Payment link expired. Please contact us.' });
    if (payReq.status === 'paid')
      return res.status(400).json({ error: 'Already paid.' });
    if (payReq.status === 'cancelled')
      return res.status(410).json({ error: 'Payment link cancelled.' });

    const quote = await getQuote(payReq.quoteId);
    if (!quote) return res.status(404).json({ error: 'Booking not found.' });

    const proto   = req.headers['x-forwarded-proto'] || 'https';
    const host    = req.headers.host;
    const baseUrl = `${proto}://${host}`;

    const studios = (quote.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + ');

    const yocoRes = await fetch(YOCO_CHECKOUT_URL, {
      method:  'POST',
      headers: {
        'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}`,
        'Content-Type':  'application/json',
      },
      body: JSON.stringify({
        amount:     payReq.amountCents,
        currency:   'ZAR',
        successUrl: `${baseUrl}/pay.html?token=${token}&status=paid&quoteId=${quote.quoteId}`,
        cancelUrl:  `${baseUrl}/pay.html?token=${token}&status=cancelled`,
        failureUrl: `${baseUrl}/pay.html?token=${token}&status=failed`,
        metadata:   { quoteId: quote.quoteId, token, studios },
      }),
    });

    const checkout = await yocoRes.json();
    if (!checkout.redirectUrl) {
      console.error('[pay-initiate] Yoco error:', JSON.stringify(checkout));
      return res.status(502).json({ error: 'Payment provider error. Please try again.' });
    }

    // Store checkoutId on payment request for verification later
    await updatePaymentRequest(token, { checkoutId: checkout.id });

    return res.status(200).json({ redirectUrl: checkout.redirectUrl, quoteId: quote.quoteId });
  } catch (err) {
    console.error('[pay-initiate]', err);
    return res.status(500).json({ error: 'Something went wrong. Please try again.' });
  }
}
