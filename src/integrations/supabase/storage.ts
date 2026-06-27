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
  setChunkedCredential,
} from "~/integrations/auth/chunked";
import { readSupabaseSession } from "~/integrations/auth/credentials";

const SERVICE = "supabase.session";
const browserSessionFallback = new Map<string, string>();

type TauriWindow = Window & {
  __TAURI_INTERNALS__?: {
    invoke?: unknown;
  };
};

function sanitizeAccount(key: string): string {
  return key.replace(/[\\/]/g, "_");
}

function hasTauriIpc(): boolean {
  if (typeof window === "undefined") return false;
  return typeof (window as TauriWindow).__TAURI_INTERNALS__?.invoke === "function";
}

// Chunked storage is load-bearing here: the session bundle is 2–4 KB and
// Windows Credential Manager caps a single blob at 2560 bytes — un-chunked
// writes fail and sign-in dies *after* a successful GoTrue login.
export const keyringSupabaseStorage = {
  async getItem(key: string): Promise<string | null> {
    const account = sanitizeAccount(key);
    if (!hasTauriIpc()) return browserSessionFallback.get(account) ?? null;
    return await readSupabaseSession(account);
  },
  async setItem(key: string, value: string): Promise<void> {
    const account = sanitizeAccount(key);
    if (!value) {
      browserSessionFallback.delete(account);
      if (hasTauriIpc()) await deleteChunkedCredential(SERVICE, account);
      return;
    }
    if (!hasTauriIpc()) {
      browserSessionFallback.set(account, value);
      return;
    }
    await setChunkedCredential(SERVICE, account, value);
  },
  async removeItem(key: string): Promise<void> {
    const account = sanitizeAccount(key);
    browserSessionFallback.delete(account);
    if (!hasTauriIpc()) return;
    await deleteChunkedCredential(SERVICE, account);
  },
};
