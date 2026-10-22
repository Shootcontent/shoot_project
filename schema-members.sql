-- ═══════════════════════════════════════════════════════════════════════
-- SHOOT. Club — Members schema for Supabase
-- Run this in the Supabase SQL Editor
-- ═══════════════════════════════════════════════════════════════════════

-- Sequence for sequential member IDs (SC-001, SC-002, ...)
create sequence if not exists member_seq start 1;

-- ── Members table ──────────────────────────────────────────────────────
create table if not exists members (
  id              text primary key,                    -- SC-001, SC-002, etc.
  email           text unique not null,
  first_name      text not null,
  last_name       text not null,
  phone           text default '',
  status          text default 'active'
                    check (status in ('active', 'expired', 'cancelled')),
  tier            text default 'standard'
                    check (tier in ('founding', 'standard')),
  member_code     text unique not null,                -- 6-char code for checkout
  purchase_date   timestamptz default now(),
  expires_at      timestamptz,
  renewed_at      timestamptz,
  total_saved_cents integer default 0,
  savings_cap_cents integer default 250000,
  price_paid_cents  integer default 85000,
  yoco_checkout_id  text default '',
  note            text default '',
  created_at      timestamptz default now()
);

-- ── Savings history ────────────────────────────────────────────────────
create table if not exists member_savings (
  id              serial primary key,
  member_id       text not null references members(id) on delete cascade,
  booking_id      text not null,
  saved_cents     integer not null,
  created_at      timestamptz default now()
);

-- ── Indexes ────────────────────────────────────────────────────────────
create index if not exists idx_members_email on members(email);
create index if not exists idx_members_code on members(member_code);
create index if not exists idx_members_status on members(status);
create index if not exists idx_member_savings_member on member_savings(member_id);

-- ── RLS ────────────────────────────────────────────────────────────────
alter table members enable row level security;
alter table member_savings enable row level security;

-- Service role (used by serverless functions) bypasses RLS automatically.
-- No anon/public policies needed — members are managed server-side only.

-- ── RPC to get next member number ──────────────────────────────────────
create or replace function next_member_number()
returns integer
language sql
security definer
as $$
  select nextval('member_seq')::integer;
$$;

-- ── Grants (required after Oct 30 2026 Supabase change) ───────────────
grant all on members to authenticated, service_role;
grant all on member_savings to authenticated, service_role;
grant usage, select on sequence member_seq to authenticated, service_role;
grant usage, select on sequence member_savings_id_seq to authenticated, service_role;
grant execute on function next_member_number() to authenticated, service_role;
