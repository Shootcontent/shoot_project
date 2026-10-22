/**
 * _member.js — Supabase membership CRUD helpers
 *
 * Tables: members, member_savings (see schema-members.sql)
 * All operations use service_role key (bypasses RLS).
 */

import { supabase } from './_supabase.js';

const SAVINGS_CAP_CENTS = 250000; // R2,500
const FOUNDING_LIMIT    = 25;
const MEMBERSHIP_PRICE  = 85000;  // R850 in cents

export { SAVINGS_CAP_CENTS, FOUNDING_LIMIT, MEMBERSHIP_PRICE };

/** Generate a short 6-char alphanumeric member code */
function genCode() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code = '';
  for (let i = 0; i < 6; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/** Map DB row to member object (camelCase) */
function mapRow(row) {
  if (!row) return null;
  return {
    memberId:        row.id,
    email:           row.email || '',
    firstName:       row.first_name || '',
    lastName:        row.last_name || '',
    phone:           row.phone || '',
    status:          row.status || 'active',
    tier:            row.tier || 'standard',
    memberCode:      row.member_code || '',
    purchaseDate:    row.purchase_date || '',
    expiresAt:       row.expires_at || '',
    renewedAt:       row.renewed_at || '',
    totalSavedCents: row.total_saved_cents || 0,
    savingsCapCents: row.savings_cap_cents || SAVINGS_CAP_CENTS,
    pricePaidCents:  row.price_paid_cents || 0,
    yocoCheckoutId:  row.yoco_checkout_id || '',
    createdAt:       row.created_at || '',
    note:            row.note || '',
  };
}

/** Create a new member. Returns the member object. */
export async function createMember({ email, firstName, lastName, phone, pricePaidCents, yocoCheckoutId = '', note = '' }) {
  if (!email) throw new Error('Email is required.');
  if (!firstName || !lastName) throw new Error('Full name is required.');

  const normEmail = email.toLowerCase().trim();

  // Check if email already registered
  const { data: existing } = await supabase
    .from('members').select('id').eq('email', normEmail).maybeSingle();
  if (existing) throw new Error(`A member with email ${normEmail} already exists.`);

  // Get next sequential ID via Postgres sequence
  const { data: seqData, error: seqErr } = await supabase.rpc('next_member_number');
  let seq;
  if (seqErr || seqData == null) {
    // Fallback: count existing members
    const { count } = await supabase.from('members').select('id', { count: 'exact', head: true });
    seq = (count || 0) + 1;
  } else {
    seq = Number(seqData);
  }

  const memberId = `SC-${String(seq).padStart(3, '0')}`;
  const tier = seq <= FOUNDING_LIMIT ? 'founding' : 'standard';

  // Generate unique member code
  let memberCode = genCode();
  let tries = 0;
  while (tries < 10) {
    const { data: dup } = await supabase
      .from('members').select('id').eq('member_code', memberCode).maybeSingle();
    if (!dup) break;
    memberCode = genCode();
    tries++;
  }

  const now = new Date().toISOString();
  const expiresAt = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000).toISOString();

  const { data: row, error } = await supabase.from('members').insert({
    id:                memberId,
    email:             normEmail,
    first_name:        firstName.trim(),
    last_name:         lastName.trim(),
    phone:             (phone || '').trim(),
    status:            'active',
    tier,
    member_code:       memberCode,
    purchase_date:     now,
    expires_at:        expiresAt,
    total_saved_cents: 0,
    savings_cap_cents: SAVINGS_CAP_CENTS,
    price_paid_cents:  pricePaidCents || MEMBERSHIP_PRICE,
    yoco_checkout_id:  yocoCheckoutId,
    note,
    created_at:        now,
  }).select().single();

  if (error) throw new Error(`Failed to create member: ${error.message}`);
  return mapRow(row);
}

/** Get a member by ID */
export async function getMember(memberId) {
  const { data } = await supabase
    .from('members').select('*').eq('id', memberId).maybeSingle();
  return mapRow(data);
}

/** Get a member by email */
export async function getMemberByEmail(email) {
  const { data } = await supabase
    .from('members').select('*').eq('email', email.toLowerCase().trim()).maybeSingle();
  return mapRow(data);
}

/** Get a member by their short checkout code */
export async function getMemberByCode(code) {
  const { data } = await supabase
    .from('members').select('*').eq('member_code', code.toUpperCase().trim()).maybeSingle();
  return mapRow(data);
}

/** Check if email has an active, non-expired membership */
export async function isActiveMember(email) {
  const m = await getMemberByEmail(email);
  if (!m) return false;
  if (m.status !== 'active') return false;
  if (m.expiresAt && new Date(m.expiresAt) < new Date()) return false;
  return true;
}

/** List all members */
export async function listMembers() {
  const { data, error } = await supabase
    .from('members').select('*').order('created_at', { ascending: false });
  if (error) throw new Error(`Failed to list members: ${error.message}`);
  return (data || []).map(mapRow);
}

/** Update member fields */
export async function updateMember(memberId, updates) {
  const allowed = ['firstName', 'lastName', 'phone', 'status', 'expiresAt', 'note', 'totalSavedCents', 'savingsCapCents'];
  const dbUpdates = {};

  const fieldMap = {
    firstName:       'first_name',
    lastName:        'last_name',
    phone:           'phone',
    status:          'status',
    expiresAt:       'expires_at',
    note:            'note',
    totalSavedCents: 'total_saved_cents',
    savingsCapCents: 'savings_cap_cents',
  };

  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    dbUpdates[fieldMap[k] || k] = v;
  }

  if (Object.keys(dbUpdates).length === 0) throw new Error('No valid fields to update.');

  const { data, error } = await supabase
    .from('members').update(dbUpdates).eq('id', memberId).select().single();
  if (error) throw new Error(`Failed to update member: ${error.message}`);
  return mapRow(data);
}

/** Delete a member entirely */
export async function deleteMember(memberId) {
  const { error } = await supabase
    .from('members').delete().eq('id', memberId);
  if (error) throw new Error(`Failed to delete member: ${error.message}`);
}

/** Record a savings event against a member's cap */
export async function recordSaving(memberId, bookingId, savedCents) {
  if (savedCents <= 0) return;

  const { error: insertErr } = await supabase.from('member_savings').insert({
    member_id:  memberId,
    booking_id: bookingId,
    saved_cents: savedCents,
  });
  if (insertErr) console.error('[recordSaving] insert error:', insertErr.message);

  // Increment total_saved_cents on member
  const m = await getMember(memberId);
  if (m) {
    await supabase.from('members')
      .update({ total_saved_cents: m.totalSavedCents + savedCents })
      .eq('id', memberId);
  }
}

/** Get remaining savings cap in cents */
export async function getRemainingCap(memberId) {
  const m = await getMember(memberId);
  if (!m) return 0;
  return Math.max(0, m.savingsCapCents - m.totalSavedCents);
}

/** Get savings history for a member */
export async function getSavingsHistory(memberId) {
  const { data, error } = await supabase
    .from('member_savings')
    .select('*')
    .eq('member_id', memberId)
    .order('created_at', { ascending: false });
  if (error) return [];
  return (data || []).map(r => ({
    bookingId:  r.booking_id,
    savedCents: r.saved_cents,
    createdAt:  r.created_at,
  }));
}

/** Get founding member stats */
export async function getFoundingStats() {
  const { count } = await supabase
    .from('members').select('id', { count: 'exact', head: true });
  const total = count || 0;
  return {
    total,
    foundingTaken: Math.min(total, FOUNDING_LIMIT),
    foundingRemaining: Math.max(0, FOUNDING_LIMIT - total),
  };
}
