/**
 * _supabase.js — Supabase client (service role) for server-side use
 *
 * Env vars required:
 *   SUPABASE_URL          — e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_KEY  — service_role key (bypasses RLS)
 */

import { createClient } from '@supabase/supabase-js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_KEY;

if (!url || !key) {
  console.warn('[supabase] SUPABASE_URL or SUPABASE_SERVICE_KEY not set');
}

export const supabase = createClient(url || '', key || '', {
  auth: { persistSession: false, autoRefreshToken: false },
});
