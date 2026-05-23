/**
 * Supabase project config, sourced from `.env.local` at build time.
 *
 * Both values are safe to ship in the client bundle:
 *   - URL is public (it's literally a hostname).
 *   - Anon / publishable key carries no privileges of its own — RLS
 *     policies decide what the request can do based on the JWT.
 *
 * If either is missing, the entire Supabase surface is disabled. The
 * rest of the app keeps working in offline / free-tier mode — same
 * shape Phase 0's stub entitlement source covers today.
 */

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export function loadSupabaseConfig(): SupabaseConfig | null {
  const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
  const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;
  if (!url || !anonKey) return null;
  return { url, anonKey };
}

/**
 * Derives a stable project ref from the URL — used as part of the
 * keyring slot account name so multiple Supabase projects (e.g.
 * staging vs prod) don't fight over a single token.
 */
export function projectRefFromUrl(url: string): string {
  const host = url.replace(/^https?:\/\//, "").split(/[./]/)[0];
  return host || "default";
}
