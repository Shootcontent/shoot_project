/**
 * _member-discount.js — Pure member discount calculation logic
 *
 * Off-peak: Mon–Thu 08:00–13:00 → 25% off discountable
 * Other weekday: 10% off discountable
 * Weekend / holiday: 0%
 *
 * Discountable = studio hire + extra hours + addons + equipment
 * NOT discountable = photo packages + surcharges
 *
 * Savings cap enforced per member per year.
 */

const SA_HOLIDAYS = new Set([
  '2025-01-01','2025-03-21','2025-04-18','2025-04-21','2025-04-28',
  '2025-05-01','2025-06-16','2025-08-09','2025-09-24',
  '2025-12-16','2025-12-25','2025-12-26',
  '2026-01-01','2026-03-21','2026-03-23','2026-04-03','2026-04-06',
  '2026-04-27','2026-05-01','2026-06-16','2026-08-10','2026-09-24',
  '2026-12-16','2026-12-25','2026-12-26',
  '2027-01-01','2027-03-21','2027-04-02','2027-04-05',
  '2027-04-27','2027-05-01','2027-06-16','2027-08-09','2027-09-24',
  '2027-12-16','2027-12-25','2027-12-26',
]);

const OFF_PEAK_RATE = 25; // percent
const PEAK_RATE     = 10; // percent

/**
 * Get the member discount rate for a given date and time.
 * Returns { rate, label } where rate is 0, 10, or 25.
 */
export function getMemberRate(date, time) {
  if (!date) return { rate: 0, label: 'No discount' };

  const d   = new Date(date + 'T00:00:00');
  const dow = d.getDay(); // 0=Sun, 6=Sat

  // Weekend or holiday = no discount
  if (dow === 0 || dow === 6 || SA_HOLIDAYS.has(date)) {
    return { rate: 0, label: 'No weekend discount' };
  }

  // Weekday — check off-peak (Mon–Thu 08:00–13:00)
  // Friday (dow=5) gets 10% only, not 25%
  if (dow >= 1 && dow <= 4 && time) {
    const [hh, mm] = time.split(':').map(Number);
    const startHour = hh + mm / 60;
    if (startHour >= 8 && startHour < 13) {
      return { rate: OFF_PEAK_RATE, label: '25% off — off-peak' };
    }
  }

  // Other weekday hours
  return { rate: PEAK_RATE, label: '10% off — weekday' };
}

/**
 * Calculate member discount in rands (integer).
 * @param {object} opts
 * @param {number} opts.discountableAmount — studio + extra + addons + equipment in rands
 * @param {string} opts.date — YYYY-MM-DD
 * @param {string} opts.time — HH:MM
 * @param {number} opts.remainingCapCents — remaining savings cap in cents
 * @returns {{ discountRands: number, rate: number, label: string, cappedAt: number|null }}
 */
export function calcMemberDiscount({ discountableAmount, date, time, remainingCapCents }) {
  const { rate, label } = getMemberRate(date, time);

  if (rate === 0) {
    return { discountRands: 0, rate: 0, label, cappedAt: null };
  }

  let discountRands = Math.round(discountableAmount * rate / 100);

  // Enforce savings cap
  const discountCents = discountRands * 100;
  let cappedAt = null;
  if (remainingCapCents !== undefined && remainingCapCents !== null && discountCents > remainingCapCents) {
    discountRands = Math.floor(remainingCapCents / 100);
    cappedAt = discountRands;
  }

  return { discountRands, rate, label, cappedAt };
}
