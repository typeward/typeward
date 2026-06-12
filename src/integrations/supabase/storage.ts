/**
 * Keyring-backed storage adapter for supabase-js.
 *
 * supabase-js's auth layer persists the session under a single
 * `sb-<project-ref>-auth-token` key. By default it goes to
 * `localStorage` — fine in a browser, wrong for a desktop app where
 * we already have an OS keyring for every other token.
 *
 * This adapter routes the same get/set/remove calls through the
 * `typeward.supabase.session` keyring slot so the session bundle
 * (access + refresh token + expiry) sits next to OAuth credentials
 * for Mendeley / Dropbox / GitHub / etc.
 *
 * The slot account is the supabase-js storage *key* itself —
 * supabase-js may set multiple sub-keys; each becomes its own keyring
 * entry. Slashes are stripped because `credentials::set_secret`
 * validates them out.
 */

import {
  deleteChunkedCredential,
  getChunkedCredential,
  setChunkedCredential,
} from "~/integrations/auth/chunked";

const SERVICE = "supabase.session";

function sanitizeAccount(key: string): string {
  return key.replace(/[\\/]/g, "_");
}

// Chunked storage is load-bearing here: the session bundle is 2–4 KB and
// Windows Credential Manager caps a single blob at 2560 bytes — un-chunked
// writes fail and sign-in dies *after* a successful GoTrue login.
export const keyringSupabaseStorage = {
  async getItem(key: string): Promise<string | null> {
    return await getChunkedCredential(SERVICE, sanitizeAccount(key));
  },
  async setItem(key: string, value: string): Promise<void> {
    if (!value) return; // keyring rejects empty secrets; treat empty set as remove.
    await setChunkedCredential(SERVICE, sanitizeAccount(key), value);
  },
  async removeItem(key: string): Promise<void> {
    await deleteChunkedCredential(SERVICE, sanitizeAccount(key));
  },
};
