/**
 * Single catch-all handler for all /api/admin/* routes.
 * Vercel Hobby plan allows max 12 serverless functions;
 * this consolidates all 14 admin handlers into one entry point.
 *
 * Routes:
 *   /api/admin/audit
 *   /api/admin/booking
 *   /api/admin/bookings
 *   /api/admin/calc-price
 *   /api/admin/coupon
 *   /api/admin/coupons
 *   /api/admin/dashboard
 *   /api/admin/login
 *   /api/admin/logout
 *   /api/admin/me
 *   /api/admin/pending-payments
 *   /api/admin/quote
 *   /api/admin/quotes
 *   /api/admin/slots
 *   /api/admin/util  (legacy admin utility: list, flush, test-email)
 */

import audit          from './_audit.js';
import booking        from './_booking.js';
import bookings       from './_bookings.js';
import calcPrice      from './_calc-price.js';
import coupon         from './_coupon.js';
import coupons        from './_coupons.js';
import dashboard      from './_dashboard.js';
import login          from './_login.js';
import logout         from './_logout.js';
import me             from './_me.js';
import pendingPayments from './_pending-payments.js';
import quote          from './_quote.js';
import quotes         from './_quotes.js';
import slots          from './_slots.js';
import util           from './_util.js';

const ROUTES = {
  audit,
  booking,
  bookings,
  'calc-price':       calcPrice,
  coupon,
  coupons,
  dashboard,
  login,
  logout,
  me,
  'pending-payments': pendingPayments,
  quote,
  quotes,
  slots,
  util,
};

export default function handler(req, res) {
  const route = req.query.route;
  const fn    = ROUTES[route];

  if (!fn) {
    return res.status(404).json({ error: `Unknown admin route: ${route}` });
  }

  // Strip the routing segment so handlers see clean query params
  delete req.query.route;

  return fn(req, res);
}
