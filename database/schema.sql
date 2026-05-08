-- ─────────────────────────────────────────────────────────────────────────────
-- SHOOT. Studios — Supabase Schema
-- Run this in the Supabase SQL editor: https://supabase.com → SQL Editor
-- ─────────────────────────────────────────────────────────────────────────────

-- UUID support (already available in Supabase)
CREATE EXTENSION IF NOT EXISTS "pgcrypto";

-- ── Bookings ──────────────────────────────────────────────────────────────────
-- One row per booking attempt. Created when the slot is locked, updated as
-- payment progresses. Confirmed bookings are the source of truth for availability.
CREATE TABLE IF NOT EXISTS bookings (
  id                    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  -- Customer
  first_name            TEXT        NOT NULL,
  last_name             TEXT        NOT NULL,
  email                 TEXT        NOT NULL,
  phone                 TEXT        NOT NULL,

  -- Slot
  studios               TEXT[]      NOT NULL,         -- ['curve','studio1','pool']
  date                  DATE        NOT NULL,
  start_time            TIME        NOT NULL,
  end_time              TIME        NOT NULL,
  duration_key          TEXT        NOT NULL,          -- '90min'|'2hrs'|'3hrs'|'halfday'|'fullday'
  extra_hours           INT         NOT NULL DEFAULT 0,

  -- Services
  photo_package         TEXT        NOT NULL DEFAULT 'none',
  addons                JSONB       NOT NULL DEFAULT '{}',
  camera_body           TEXT,
  rental_duration       TEXT,
  lens_choice           TEXT,

  -- Pricing (all in cents to avoid floating point)
  total_amount_cents    INT         NOT NULL,
  promo_applied         BOOLEAN     NOT NULL DEFAULT FALSE,
  promo_discount_cents  INT         NOT NULL DEFAULT 0,

  -- Payment lifecycle
  status                TEXT        NOT NULL DEFAULT 'pending'
                        CHECK (status IN ('pending','locked','confirmed','failed','cancelled','refunded')),
  yoco_checkout_id      TEXT,
  yoco_payment_id       TEXT,
  confirmed_at          TIMESTAMPTZ,

  -- Full snapshot of the booking form state (for admin visibility)
  booking_data          JSONB       NOT NULL DEFAULT '{}'
);

-- ── Slot Locks ────────────────────────────────────────────────────────────────
-- Temporary hold placed while a customer is paying. Expires after 10 minutes
-- if payment is not completed. Prevents double-booking during checkout.
CREATE TABLE IF NOT EXISTS slot_locks (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  lock_token   UUID        NOT NULL UNIQUE DEFAULT gen_random_uuid(),
  booking_id   UUID        NOT NULL REFERENCES bookings(id) ON DELETE CASCADE,

  studios      TEXT[]      NOT NULL,
  date         DATE        NOT NULL,
  start_time   TIME        NOT NULL,
  end_time     TIME        NOT NULL,
  expires_at   TIMESTAMPTZ NOT NULL,

  status       TEXT        NOT NULL DEFAULT 'active'
               CHECK (status IN ('active','confirmed','released','expired'))
);

-- ── Indexes ───────────────────────────────────────────────────────────────────
CREATE INDEX IF NOT EXISTS idx_bookings_date        ON bookings(date);
CREATE INDEX IF NOT EXISTS idx_bookings_status      ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_bookings_email       ON bookings(email);
CREATE INDEX IF NOT EXISTS idx_bookings_yoco_co     ON bookings(yoco_checkout_id);
CREATE INDEX IF NOT EXISTS idx_bookings_studios     ON bookings USING GIN(studios);

CREATE INDEX IF NOT EXISTS idx_locks_date_status    ON slot_locks(date, status, expires_at);
CREATE INDEX IF NOT EXISTS idx_locks_studios        ON slot_locks USING GIN(studios);
CREATE INDEX IF NOT EXISTS idx_locks_booking        ON slot_locks(booking_id);
CREATE INDEX IF NOT EXISTS idx_locks_token          ON slot_locks(lock_token);

-- ── Auto-update updated_at ────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION update_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS bookings_updated_at ON bookings;
CREATE TRIGGER bookings_updated_at
  BEFORE UPDATE ON bookings
  FOR EACH ROW EXECUTE FUNCTION update_updated_at();

-- ── Atomic Slot Lock ──────────────────────────────────────────────────────────
-- Called by /api/lock-slot. Runs inside a single transaction so concurrent
-- requests cannot both succeed for the same slot. Returns success=false if
-- the slot is already confirmed or actively locked.
CREATE OR REPLACE FUNCTION lock_slot_atomic(
  p_studios             TEXT[],
  p_date                DATE,
  p_start_time          TIME,
  p_end_time            TIME,
  p_booking_data        JSONB,
  p_total_amount_cents  INT
) RETURNS TABLE (
  success          BOOLEAN,
  lock_token       UUID,
  booking_id       UUID,
  lock_expires_at  TIMESTAMPTZ,
  message          TEXT
) LANGUAGE plpgsql AS $$
DECLARE
  v_lock_token  UUID        := gen_random_uuid();
  v_booking_id  UUID;
  v_expires_at  TIMESTAMPTZ := NOW() + INTERVAL '10 minutes';
BEGIN
  -- Expire stale locks before checking (housekeeping)
  UPDATE slot_locks SET status = 'expired'
  WHERE  status = 'active' AND expires_at <= NOW();

  -- Guard: confirmed booking overlaps?
  IF EXISTS (
    SELECT 1 FROM bookings
    WHERE  status     = 'confirmed'
    AND    date       = p_date
    AND    start_time < p_end_time
    AND    end_time   > p_start_time
    AND    studios    && p_studios
  ) THEN
    RETURN QUERY
      SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ,
             'That slot is already booked'::TEXT;
    RETURN;
  END IF;

  -- Guard: active lock overlaps?
  IF EXISTS (
    SELECT 1 FROM slot_locks
    WHERE  status     = 'active'
    AND    expires_at > NOW()
    AND    date       = p_date
    AND    start_time < p_end_time
    AND    end_time   > p_start_time
    AND    studios    && p_studios
  ) THEN
    RETURN QUERY
      SELECT FALSE, NULL::UUID, NULL::UUID, NULL::TIMESTAMPTZ,
             'That slot is temporarily held — please try again in a few minutes'::TEXT;
    RETURN;
  END IF;

  -- Create booking row (status = 'pending' until payment succeeds)
  INSERT INTO bookings (
    first_name, last_name, email, phone,
    studios, date, start_time, end_time,
    duration_key, extra_hours,
    photo_package, addons, camera_body, rental_duration, lens_choice,
    total_amount_cents, promo_applied, promo_discount_cents,
    status, booking_data
  ) VALUES (
    p_booking_data->>'firstName',
    p_booking_data->>'lastName',
    p_booking_data->>'email',
    p_booking_data->>'phone',
    p_studios,
    p_date,
    p_start_time,
    p_end_time,
    p_booking_data->>'durationKey',
    COALESCE((p_booking_data->>'extraHours')::INT,  0),
    COALESCE(p_booking_data->>'photoPackage', 'none'),
    COALESCE(p_booking_data->'addons',        '{}'),
    p_booking_data->>'cameraBody',
    p_booking_data->>'rentalDuration',
    p_booking_data->>'lensChoice',
    p_total_amount_cents,
    COALESCE((p_booking_data->>'promoApplied')::BOOLEAN, FALSE),
    COALESCE((p_booking_data->>'promoDiscountCents')::INT, 0),
    'pending',
    p_booking_data
  )
  RETURNING id INTO v_booking_id;

  -- Place the 10-minute lock
  INSERT INTO slot_locks (lock_token, booking_id, studios, date, start_time, end_time, expires_at, status)
  VALUES (v_lock_token, v_booking_id, p_studios, p_date, p_start_time, p_end_time, v_expires_at, 'active');

  RETURN QUERY
    SELECT TRUE, v_lock_token, v_booking_id, v_expires_at, 'Slot locked for 10 minutes'::TEXT;
END;
$$;

-- ── Release Expired Locks ─────────────────────────────────────────────────────
-- Call this periodically (e.g. Supabase pg_cron or a cron job) to clean up.
CREATE OR REPLACE FUNCTION release_expired_locks()
RETURNS INT LANGUAGE plpgsql AS $$
DECLARE v_count INT;
BEGIN
  UPDATE slot_locks SET status = 'expired'
  WHERE  status = 'active' AND expires_at <= NOW();
  GET DIAGNOSTICS v_count = ROW_COUNT;

  -- Cancel the associated bookings that never got a payment
  UPDATE bookings SET status = 'cancelled'
  WHERE  status IN ('pending', 'locked')
  AND    id IN (
    SELECT booking_id FROM slot_locks WHERE status = 'expired'
  );

  RETURN v_count;
END;
$$;

-- ── Row Level Security ────────────────────────────────────────────────────────
ALTER TABLE bookings   ENABLE ROW LEVEL SECURITY;
ALTER TABLE slot_locks ENABLE ROW LEVEL SECURITY;

-- Our API functions use the service_role key which bypasses RLS.
-- Nothing is exposed to anonymous browser requests.
CREATE POLICY "service_full_access_bookings"   ON bookings   FOR ALL TO service_role USING (true) WITH CHECK (true);
CREATE POLICY "service_full_access_slot_locks" ON slot_locks FOR ALL TO service_role USING (true) WITH CHECK (true);

-- ── Admin view: confirmed bookings calendar ───────────────────────────────────
CREATE OR REPLACE VIEW confirmed_bookings_calendar AS
SELECT
  id,
  first_name || ' ' || last_name AS customer_name,
  email,
  phone,
  studios,
  date,
  start_time,
  end_time,
  duration_key,
  photo_package,
  total_amount_cents / 100.0 AS total_rands,
  confirmed_at,
  yoco_payment_id
FROM bookings
WHERE status = 'confirmed'
ORDER BY date DESC, start_time DESC;
