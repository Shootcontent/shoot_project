// api/verify-payment.js
// Polled by booking-success.html to confirm payment status.
// Also used as a fallback if the Yoco webhook arrives late.

const { createClient } = require('@supabase/supabase-js');

const YOCO_CHECKOUT_API = 'https://payments.yoco.com/api/checkouts';
const ALLOWED_ORIGIN    = process.env.SITE_URL || 'https://www.shootstudios.co.za';

module.exports = async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin',  ALLOWED_ORIGIN);
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');

  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'GET')    return res.status(405).json({ error: 'Method not allowed' });

  const { bookingId } = req.query;
  if (!bookingId) return res.status(400).json({ error: 'Missing bookingId' });

  const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
  );

  // ── Fetch booking ───────────────────────────────────────────────────────────
  const { data: booking, error } = await supabase
    .from('bookings')
    .select('id, status, yoco_checkout_id, first_name, last_name, email, date, start_time, studios, total_amount_cents, created_at')
    .eq('id', bookingId)
    .maybeSingle();

  if (error || !booking) {
    return res.status(404).json({ error: 'Booking not found' });
  }

  // ── Already confirmed ───────────────────────────────────────────────────────
  if (booking.status === 'confirmed') {
    return res.status(200).json({
      status:  'confirmed',
      booking: safeBookingSummary(booking),
    });
  }

  // ── Already failed / cancelled ──────────────────────────────────────────────
  if (['failed', 'cancelled', 'refunded'].includes(booking.status)) {
    return res.status(200).json({ status: booking.status });
  }

  // ── Still pending/locked — check with Yoco directly ────────────────────────
  if (booking.yoco_checkout_id) {
    try {
      const yocoRes = await fetch(`${YOCO_CHECKOUT_API}/${booking.yoco_checkout_id}`, {
        headers: { 'Authorization': `Bearer ${process.env.YOCO_SECRET_KEY}` },
      });

      if (yocoRes.ok) {
        const co = await yocoRes.json();
        const yocoStatus = co.status?.toLowerCase();

        if (yocoStatus === 'succeeded' || yocoStatus === 'paid') {
          // Webhook may be delayed — confirm here as fallback
          await confirmBooking(supabase, bookingId, co.paymentId || co.id);
          return res.status(200).json({
            status:  'confirmed',
            booking: safeBookingSummary(booking),
          });
        }

        if (yocoStatus === 'failed') {
          await failBooking(supabase, bookingId);
          return res.status(200).json({ status: 'failed' });
        }

        if (yocoStatus === 'cancelled') {
          await cancelBooking(supabase, bookingId);
          return res.status(200).json({ status: 'cancelled' });
        }
      }
    } catch (err) {
      console.error('[verify-payment] Yoco fetch error:', err);
    }
  }

  // Still in progress
  return res.status(200).json({ status: booking.status });
};

// ── Helpers ───────────────────────────────────────────────────────────────────

function safeBookingSummary(b) {
  return {
    id:               b.id,
    firstName:        b.first_name,
    lastName:         b.last_name,
    email:            b.email,
    date:             b.date,
    startTime:        b.start_time,
    studios:          b.studios,
    totalRands:       (b.total_amount_cents / 100).toFixed(2),
    createdAt:        b.created_at,
  };
}

async function confirmBooking(supabase, bookingId, paymentId) {
  await supabase.from('bookings').update({
    status:          'confirmed',
    yoco_payment_id: paymentId,
    confirmed_at:    new Date().toISOString(),
  }).eq('id', bookingId);

  await supabase.from('slot_locks').update({ status: 'confirmed' }).eq('booking_id', bookingId);
}

async function failBooking(supabase, bookingId) {
  await supabase.from('bookings').update({ status: 'failed' }).eq('id', bookingId);
  await supabase.from('slot_locks').update({ status: 'released' }).eq('booking_id', bookingId).eq('status', 'active');
}

async function cancelBooking(supabase, bookingId) {
  await supabase.from('bookings').update({ status: 'cancelled' }).eq('id', bookingId);
  await supabase.from('slot_locks').update({ status: 'released' }).eq('booking_id', bookingId).eq('status', 'active');
}
