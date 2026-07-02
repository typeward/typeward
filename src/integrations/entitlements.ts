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

import {
  KNOWN_ENTITLEMENT_KEYS,
  type EntitlementKey,
  type EntitlementSource,
  type Tier,
} from "./types";

const KNOWN_KEYS = new Set<string>(KNOWN_ENTITLEMENT_KEYS);

/**
 * Dev-only tripwire: the type system already blocks literal typos, but keys
 * built dynamically from a provider id can still drift from the seeded matrix.
 * Surface those loudly in dev instead of the feature silently vanishing.
 */
function warnIfUnknownKey(key: string): void {
  if (import.meta.env.DEV && !KNOWN_KEYS.has(key)) {
    console.warn(
      `[entitlements] queried unknown key '${key}' — add it to KNOWN_ENTITLEMENT_KEYS and seed.sql, or fix the typo.`,
    );
  }
}

const FREE_ENTITLEMENTS = new Set<EntitlementKey>([
  "integrations.references.zotero.local",
  "integrations.references.doi_lookup",
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
  warnIfUnknownKey(key);
  return () => currentSource().has(key);
}

/**
 * One-shot check, for non-reactive contexts (command handlers, IPC call
 * sites). Returns true if the user is currently entitled; false otherwise.
 *
 * Use `assertEntitlement` instead when you want to short-circuit a command
 * with a thrown error the surrounding handler can surface.
 */
export function hasEntitlement(key: EntitlementKey): boolean {
  warnIfUnknownKey(key);
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
