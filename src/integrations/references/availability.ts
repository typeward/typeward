/**
 * Shared, session-cached reachability probe for citation providers. Both the
 * editor sidebar's Refs-tab gate and the ReferencesPanel manager dropdown read
 * from this single probe rather than each running their own `status()` fan-out.
 *
 * The probe never flips to a definitive "none-ready" mid-flight: while a
 * re-probe is loading, the last settled result stands, and until the first
 * probe settles the state is "unknown" (so a configured user sees their tab
 * immediately — it only disappears after proof that every provider is
 * unreachable).
 */

import { createEffect, createResource, createRoot, createSignal } from "solid-js";

import { citationProviders } from "./registry";

export type RefsAvailability = "unknown" | "some-ready" | "none-ready";

const [probeTick, setProbeTick] = createSignal(0);

/** Re-run the reachability probe (wired to the panel's Refresh action). */
export function refreshAvailability(): void {
  setProbeTick((n) => n + 1);
}

// Last settled ready-id list — read while a re-probe is in flight so the
// reactive state doesn't flap.
let lastSettled: readonly string[] = [];

const [settledOnce, setSettledOnce] = createSignal(false);

const probe = createRoot(() => {
  const [res] = createResource(
    () => [citationProviders(), probeTick()] as const,
    async ([provs]) => {
      // No registered providers → nothing to probe (avoids IPC when unconfigured).
      if (provs.length === 0) return [] as string[];
      const settled = await Promise.all(
        provs.map((p) =>
          p
            .status()
            .then((s) => (s === "ready" ? p.id : null))
            .catch(() => null),
        ),
      );
      return settled.filter((id): id is string => id !== null);
    },
    { initialValue: [] as string[] },
  );

  createEffect(() => {
    if (!res.loading) {
      lastSettled = res() ?? [];
      setSettledOnce(true);
    }
  });

  return {
    readyProviders: (): readonly string[] => (res.loading ? lastSettled : res() ?? []),
    loading: (): boolean => res.loading,
  };
});

/** Ready provider ids (stable while a re-probe is in flight). */
export const readyProviders = probe.readyProviders;

/** True while a probe is running. */
export const refsAvailabilityLoading = probe.loading;

export function refsAvailability(): RefsAvailability {
  const ready = readyProviders();
  if (!settledOnce()) return "unknown";
  return ready.length > 0 ? "some-ready" : "none-ready";
}
