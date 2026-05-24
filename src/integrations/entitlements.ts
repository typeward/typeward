/**
 * Entitlement gate. Every integration call site that's behind a paid tier
 * reads through `useEntitlement(key)` (this file). The fallback source is
 * the free tier so unsigned-out/offline users get local features, while
 * paid integrations fail closed until Supabase resolves a subscription.
 *
 * Tokens / sessions never live here — credentials go through the keyring.
 * This module only consumes already-resolved tier + feature-flag state.
 */

import { createSignal } from "solid-js";

import type { EntitlementKey, EntitlementSource, Tier } from "./types";

const FREE_ENTITLEMENTS = new Set<EntitlementKey>([
  "integrations.references.zotero.local",
  "integrations.references.jabref",
  "integrations.references.doi_lookup",
  "integrations.cloud.icloud",
  "integrations.vcs.git",
  "integrations.vcs.github",
  "integrations.vcs.overleaf_import",
  "integrations.ai.ollama",
  "integrations.grammar.harper",
  "templates.builtin.free",
  "templates.custom.max",
]);

const freeTierSource: EntitlementSource = {
  current: () => "free",
  has: (key) => FREE_ENTITLEMENTS.has(key),
  reasonIfMissing: (key) => (FREE_ENTITLEMENTS.has(key) ? undefined : "no-account"),
};

const [currentSource, setCurrentSource] = createSignal<EntitlementSource>(freeTierSource);

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
 * Swap the active entitlement source. Supabase wiring calls this after
 * sign-in and `resetEntitlementSource` on sign-out. No other code should
 * call this — it's the seam, not an API.
 */
export function setEntitlementSource(source: EntitlementSource): void {
  setCurrentSource(() => source);
}

/** Restore the free-tier fallback. Useful in tests; also called on sign-out. */
export function resetEntitlementSource(): void {
  setCurrentSource(() => freeTierSource);
}
