/**
 * Entitlement gate. Every integration call site that's behind a paid tier
 * reads through `useEntitlement(key)` (this file). Phase 0 ships a stub
 * source that grants everything — there is no Supabase session yet — so
 * the gates exist as plumbing without actually locking anything down.
 *
 * Phase 7 (Supabase auth) swaps `currentSource` for a real source backed
 * by the user's subscription. Because every call site already reads
 * through `useEntitlement`, that swap is a one-file change.
 *
 * Tokens / sessions never live here — credentials go through the keyring.
 * This module only consumes already-resolved tier + feature-flag state.
 */

import { createSignal } from "solid-js";

import type { EntitlementKey, EntitlementSource, Tier } from "./types";

/**
 * Stub source: returns the highest tier and grants every entitlement.
 * Used until the Supabase source is wired in Phase 7 — same shape, just
 * "yes" for everything.
 */
const stubSource: EntitlementSource = {
  current: () => "team",
  has: () => true,
  reasonIfMissing: () => undefined,
};

const [currentSource, setCurrentSource] = createSignal<EntitlementSource>(stubSource);

/**
 * Reactive entitlement check. Read this inside JSX or any tracking scope —
 * when Phase 7 swaps the source, gated UI re-renders automatically.
 */
export function useEntitlement(key: EntitlementKey): () => boolean {
  return () => currentSource().has(key);
}

/**
 * One-shot check, for non-reactive contexts (command handlers, IPC call
 * sites). Returns true if the user is currently entitled; false otherwise.
 *
 * Use `assertEntitlement` instead when you want to short-circuit a command
 * with a thrown error so the surrounding palette/keyboard handler can
 * render an UpgradePrompt fallback.
 */
export function hasEntitlement(key: EntitlementKey): boolean {
  return currentSource().has(key);
}

export type EntitlementMissingReason = ReturnType<EntitlementSource["reasonIfMissing"]>;

export class EntitlementMissingError extends Error {
  readonly key: EntitlementKey;
  readonly reason: EntitlementMissingReason;

  constructor(key: EntitlementKey, reason: EntitlementMissingReason) {
    super(`Entitlement '${key}' is not available (${reason ?? "unknown"})`);
    this.key = key;
    this.reason = reason;
    this.name = "EntitlementMissingError";
  }
}

export function assertEntitlement(key: EntitlementKey): void {
  const source = currentSource();
  if (!source.has(key)) {
    throw new EntitlementMissingError(key, source.reasonIfMissing(key));
  }
}

export function currentTier(): Tier {
  return currentSource().current();
}

/**
 * Swap the active entitlement source. Phase 7's Supabase wiring calls this
 * once after sign-in (and again with `stubSource` on sign-out). No other
 * code should call this — it's the seam, not an API.
 */
export function setEntitlementSource(source: EntitlementSource): void {
  setCurrentSource(() => source);
}

/** Restore the stub source. Useful in tests; also called on sign-out. */
export function resetEntitlementSource(): void {
  setCurrentSource(() => stubSource);
}
