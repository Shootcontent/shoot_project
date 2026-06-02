/**
 * _coupon.js — Redis coupon CRUD helpers
 *
 * Redis structures:
 *   coupon:{CODE}              HASH  { type, value, maxUses, currentUses, expiresAt, active, createdAt, description }
 *   coupon:idx:all             SET   { CODE, ... }
 *   coupon:idx:active          SET   { CODE, ... }
 */

import { kv, kvHGetAll } from './_kv.js';

export function couponKey(code) { return `coupon:${code.toUpperCase().trim()}`; }

/** Parses raw HGETALL result into a typed coupon object */
export function parseCoupon(code, raw) {
  if (!raw || !raw.type) return null;
  return {
    code:         code.toUpperCase(),
    type:         raw.type,                         // 'percent' | 'fixed'
    value:        parseFloat(raw.value) || 0,
    maxUses:      parseInt(raw.maxUses, 10) || 0,   // 0 = unlimited
    currentUses:  parseInt(raw.currentUses, 10) || 0,
    expiresAt:    raw.expiresAt || '',               // ISO string or ''
    active:       raw.active === '1',
    createdAt:    raw.createdAt || '',
    description:  raw.description || '',
    customerEmail: raw.customerEmail || '',
  };
}

/** Create a new coupon. Throws if code already exists. */
export async function createCoupon({ code, type, value, maxUses = 0, expiresAt = '', description = '', customerEmail = '' }) {
  const upperCode = code.toUpperCase().trim();
  if (!upperCode) throw new Error('Coupon code is required.');
  if (!['percent', 'fixed'].includes(type)) throw new Error('Type must be percent or fixed.');
  if (!value || value <= 0) throw new Error('Value must be positive.');

  const existing = await kvHGetAll(couponKey(upperCode));
  if (existing && existing.type) throw new Error(`Coupon ${upperCode} already exists.`);

  const fields = [
    'type',          type,
    'value',         String(value),
    'maxUses',       String(maxUses),
    'currentUses',   '0',
    'expiresAt',     expiresAt || '',
    'active',        '1',
    'createdAt',     new Date().toISOString(),
    'description',   description || '',
    'customerEmail', customerEmail || '',
  ];

  await kv('HSET', couponKey(upperCode), ...fields);
  await kv('SADD', 'coupon:idx:all', upperCode);
  await kv('SADD', 'coupon:idx:active', upperCode);

  return parseCoupon(upperCode, Object.fromEntries(
    fields.reduce((acc, v, i) => { if (i % 2 === 0) acc.push([v, fields[i+1]]); return acc; }, [])
  ));
}

/** Update coupon fields. Manages active index automatically. */
export async function updateCoupon(code, updates) {
  const upperCode = code.toUpperCase().trim();
  const existing  = await kvHGetAll(couponKey(upperCode));
  if (!existing || !existing.type) throw new Error('Coupon not found.');

  const allowed = ['type', 'value', 'maxUses', 'expiresAt', 'description', 'active', 'customerEmail'];
  const fields  = [];

  for (const [k, v] of Object.entries(updates)) {
    if (!allowed.includes(k)) continue;
    fields.push(k, String(v));
  }

  if (fields.length === 0) throw new Error('No valid fields to update.');
  await kv('HSET', couponKey(upperCode), ...fields);

  // Keep active index in sync
  if ('active' in updates) {
    if (String(updates.active) === '1' || updates.active === true) {
      await kv('SADD', 'coupon:idx:active', upperCode);
    } else {
      await kv('SREM', 'coupon:idx:active', upperCode);
    }
  }

  const updated = await kvHGetAll(couponKey(upperCode));
  return parseCoupon(upperCode, updated);
}

/** Delete a coupon entirely */
export async function deleteCoupon(code) {
  const upperCode = code.toUpperCase().trim();
  await kv('DEL', couponKey(upperCode));
  await kv('SREM', 'coupon:idx:all', upperCode);
  await kv('SREM', 'coupon:idx:active', upperCode);
}

/** Get a single coupon */
export async function getCoupon(code) {
  const upperCode = code.toUpperCase().trim();
  const raw = await kvHGetAll(couponKey(upperCode));
  return parseCoupon(upperCode, raw);
}

/** List all coupons */
export async function listCoupons() {
  const codes = await kv('SMEMBERS', 'coupon:idx:all');
  if (!codes || codes.length === 0) return [];
  const coupons = await Promise.all(
    codes.map(async c => {
      const raw = await kvHGetAll(couponKey(c));
      return parseCoupon(c, raw);
    })
  );
  return coupons
    .filter(Boolean)
    .sort((a, b) => (b.createdAt > a.createdAt ? 1 : -1));
}
