/**
 * Reactive Supabase session signal + boot-time listener.
 *
 * On boot we kick off `auth.getSession()` (recovers any persisted
 * session from the keyring) and subscribe to `onAuthStateChange` so
 * sign-in / sign-out / refresh events flow into the same signal.
 *
 * Phase 7.4 reads from this signal to flip the entitlement source
 * between the stub and the real Supabase-backed one without callers
 * needing to know either exists.
 */

import type { Session, User } from "@supabase/supabase-js";
import { createSignal } from "solid-js";

import { getSupabaseClient } from "./client";

const [session, setSession] = createSignal<Session | null>(null);
const [ready, setReady] = createSignal(false);

export const supabaseSession = session;
export const supabaseSessionReady = ready;
export function supabaseUser(): User | null {
  return session()?.user ?? null;
}

let started = false;

/**
 * Mount the session listener. Idempotent — safe to call from App.tsx
 * boot and from any tests that want to opt in.
 */
export function startSupabaseSession(): void {
  if (started) return;
  started = true;

  const client = getSupabaseClient();
  if (!client) {
    setReady(true);
    return;
  }

  void client.auth
    .getSession()
    .then(({ data }) => {
      setSession(data.session ?? null);
    })
    .catch(() => undefined)
    .finally(() => setReady(true));

  client.auth.onAuthStateChange((_event, next) => {
    setSession(next ?? null);
  });
}

/**
 * Sign out and clear the session signal. Wrapper exists so callers
 * don't have to grab the client themselves.
 */
export async function signOut(): Promise<void> {
  const client = getSupabaseClient();
  if (!client) return;
  // supabase-js resolves with { error } instead of rejecting (e.g. offline);
  // swallowing it would flip the UI to signed-out while the keyring session
  // survives and silently signs the user back in on next launch.
  const { error } = await client.auth.signOut();
  if (error) throw error;
  setSession(null);
}
