/**
 * Singleton Supabase client.
 *
 * Returns `null` when env vars are missing — the rest of the app must
 * treat that the same as "signed-out, free-tier" and not crash. Phase
 * 0's stub entitlement source already handles that case, so missing
 * Supabase config just means the user never sees an auth surface.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

import { loadSupabaseConfig } from "~/config/supabase";

import type { Database } from "./database.types";
import { keyringSupabaseStorage } from "./storage";

export type TypewardSupabaseClient = SupabaseClient<Database>;

let _client: TypewardSupabaseClient | null = null;

export function getSupabaseClient(): TypewardSupabaseClient | null {
  if (_client) return _client;
  const config = loadSupabaseConfig();
  if (!config) return null;
  _client = createClient<Database>(config.url, config.anonKey, {
    auth: {
      storage: keyringSupabaseStorage,
      persistSession: true,
      autoRefreshToken: true,
      // We don't get back-button redirects in a desktop app, so URL
      // session detection is noise.
      detectSessionInUrl: false,
    },
  });
  return _client;
}

/**
 * Returns true if Supabase config exists and the client is wired.
 * Useful for gating UI surfaces (sign-in row, account section) that
 * shouldn't render when the bundle can't reach Supabase at all.
 */
export function supabaseEnabled(): boolean {
  return loadSupabaseConfig() !== null;
}
