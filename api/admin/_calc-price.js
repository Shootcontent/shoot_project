/**
 * POST /api/admin/calc-price
 * Calculates the standard price for a booking configuration.
 * Used by the admin create-booking form to show calculated price.
 * Admin can then override with a custom price if needed.
 */

import { requireSession } from '../_admin-auth.js';

const STUDIO_PRICES = {
  curve:   { '90min': 550,  '2hrs': 900,  '3hrs': 1350, halfday: 1750, fullday: 3300 },
  studio1: { '90min': 550,  '2hrs': 700,  '3hrs': 1050, halfday: 1650, fullday: 3150 },
  pool:    { '90min': 850,  '2hrs': 1100, '3hrs': 1650, halfday: 2650, fullday: 5300 },
};
const EXTRA_RATE    = 450;
const SURCHARGE_RATE = 200;
const START_HOURS   = 8;
const AFTER_HOURS   = 17;
const DURATION_HOURS = { '90min': 1.5, '2hrs': 2, '3hrs': 3, halfday: 5, fullday: 10 };
const SA_HOLIDAYS = new Set([
  '2025-01-01','2025-03-21','2025-04-18','2025-04-21','2025-04-28','2025-05-01',
  '2025-06-16','2025-08-09','2025-09-24','2025-12-16','2025-12-25','2025-12-26',
  '2026-01-01','2026-03-21','2026-03-23','2026-04-03','2026-04-06','2026-04-27',
  '2026-05-01','2026-06-16','2026-08-10','2026-09-24','2026-12-16','2026-12-25','2026-12-26',
]);

function getSurchargeHours(date, time, duration, extra) {
  const d = new Date(date + 'T00:00:00');
  const dow = d.getDay();
  const total = (DURATION_HOURS[duration] || 0) + (extra || 0);
  if (dow === 0 || dow === 6 || SA_HOLIDAYS.has(date)) return total;
  const [hh, mm] = time.split(':').map(Number);
  const start = hh + mm / 60;
  const end   = start + total;
  return Math.max(0, Math.min(end, START_HOURS) - start) +
         Math.max(0, end - Math.max(AFTER_HOURS, start));
}

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed.' });

  const session = await requireSession(req, res);
  if (!session) return;

  const { studios = [], duration, extraHours = 0, date, time } = req.body || {};

  if (!studios.length || !duration || !date || !time) {
    return res.status(400).json({ error: 'studios, duration, date and time required.' });
  }

  try {
    let studioTotal = studios.reduce((sum, s) => {
      const p = STUDIO_PRICES[s]?.[duration];
      return sum + (p || 0);
    }, 0);

    const isInMay = new Date(date + 'T00:00:00').getMonth() === 4;
    if (duration === '3hrs' && isInMay) {
      studioTotal = studios.reduce((sum, s) => sum + (STUDIO_PRICES[s]?.['2hrs'] || 0), 0);
    }

    const extraTotal     = (extraHours || 0) * EXTRA_RATE * studios.length;
    const surchargeHours = getSurchargeHours(date, time, duration, extraHours);
    const surcharge      = Math.round(surchargeHours * SURCHARGE_RATE);
    const subtotal       = studioTotal + extraTotal + surcharge;

    return res.status(200).json({
      studioTotal,
      extraTotal,
      surcharge,
      subtotal,
      subtotalCents: subtotal * 100,
      breakdown: {
        studios:   studioTotal,
        extra:     extraTotal,
        surcharge,
      },
    });
  } catch (err) {
    return res.status(500).json({ error: err.message });
  }
}
