/**
 * _ics.js — iCalendar (.ics) generator for booking confirmation emails
 * Generates a VCALENDAR event in Africa/Johannesburg (SAST, UTC+2).
 */

const DURATION_MINS = { '90min': 90, '2hrs': 120, '3hrs': 180, halfday: 300, fullday: 600 };
const STUDIO_NAMES  = { curve: 'The Curve', studio1: 'Studio One', pool: 'The Pool' };
const DUR_LABELS    = { '90min': '90 minutes', '2hrs': '2 hours', '3hrs': '3 hours', halfday: 'Half day (5hrs)', fullday: 'Full day (10hrs)' };

function pad(n) { return String(n).padStart(2, '0'); }

function generateICS(booking) {
  const studios   = (booking.studios || []).map(s => STUDIO_NAMES[s] || s).join(' + ');
  const durLabel  = DUR_LABELS[booking.duration] || booking.duration;
  const extraMins = (booking.extraHours || 0) * 60;
  const totalMins = (DURATION_MINS[booking.duration] || 0) + extraMins;

  const [year, month, day] = booking.date.split('-').map(Number);
  const [hour, min]        = booking.time.split(':').map(Number);

  const dtStart  = `${year}${pad(month)}${pad(day)}T${pad(hour)}${pad(min)}00`;
  const endTotal = hour * 60 + min + totalMins;
  const dtEnd    = `${year}${pad(month)}${pad(day)}T${pad(Math.floor(endTotal / 60))}${pad(endTotal % 60)}00`;
  const dtstamp  = new Date().toISOString().replace(/[-:.]/g, '').slice(0, 15) + 'Z';

  const amountPaid = booking.amountPaid ?? booking.amountCents ?? 0;
  const paidStr    = `R${(amountPaid / 100).toFixed(2)}`;
  const extraLbl   = booking.extraHours > 0 ? ` + ${booking.extraHours} extra hr(s)` : '';

  const description = [
    `Booking Reference: ${booking.bookingId}`,
    `Studios: ${studios}`,
    `Duration: ${durLabel}${extraLbl}`,
    `Amount Paid: ${paidStr}`,
    ``,
    `Questions? hello@shootstudios.co.za | 060 994 8107`,
  ].join('\\n');

  return [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//SHOOT. Studios//Booking//EN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    'BEGIN:VTIMEZONE',
    'TZID:Africa/Johannesburg',
    'BEGIN:STANDARD',
    'DTSTART:19700101T000000',
    'TZOFFSETFROM:+0200',
    'TZOFFSETTO:+0200',
    'TZNAME:SAST',
    'END:STANDARD',
    'END:VTIMEZONE',
    'BEGIN:VEVENT',
    `UID:${booking.bookingId}@shootstudios.co.za`,
    `DTSTAMP:${dtstamp}`,
    `DTSTART;TZID=Africa/Johannesburg:${dtStart}`,
    `DTEND;TZID=Africa/Johannesburg:${dtEnd}`,
    `SUMMARY:SHOOT. Studios — ${studios}`,
    `DESCRIPTION:${description}`,
    'LOCATION:135 Albert Rd\\, Woodstock\\, Cape Town',
    'STATUS:CONFIRMED',
    'END:VEVENT',
    'END:VCALENDAR',
  ].join('\r\n');
}

/** Returns a Brevo-compatible attachment array with the .ics file base64-encoded. */
export function icsAttachment(booking) {
  return [{
    content: Buffer.from(generateICS(booking)).toString('base64'),
    name:    `SHOOT-Booking-${booking.bookingId}.ics`,
  }];
}
