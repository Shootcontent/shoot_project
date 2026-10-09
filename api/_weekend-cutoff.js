/**
 * Weekend Booking Cutoff
 *
 * Customers cannot book Saturday or Sunday dates after Friday 16:00 SAST.
 * SAST is always UTC+2 (no daylight saving).
 *
 * Admin bookings bypass this check entirely.
 */

/**
 * Returns true if `dateStr` (YYYY-MM-DD) is a weekend date (Sat/Sun)
 * and the current time is past the preceding Friday 16:00 SAST.
 */
export function isWeekendCutoff(dateStr) {
  const d = new Date(dateStr + 'T00:00:00Z');
  const dow = d.getUTCDay(); // 0=Sun, 6=Sat
  if (dow !== 0 && dow !== 6) return false; // not a weekend date

  // Find the preceding Friday at 16:00 SAST (= 14:00 UTC)
  const fridayOffset = dow === 6 ? 1 : 2; // Sat→1 day back, Sun→2 days back
  const fridayCutoff = new Date(d);
  fridayCutoff.setUTCDate(fridayCutoff.getUTCDate() - fridayOffset);
  fridayCutoff.setUTCHours(14, 0, 0, 0); // 16:00 SAST = 14:00 UTC

  return Date.now() >= fridayCutoff.getTime();
}
