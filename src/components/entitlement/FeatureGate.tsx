import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";

import { useEntitlement } from "~/integrations/entitlements";
import type { EntitlementKey } from "~/integrations/types";

interface FeatureGateProps {
  /** Entitlement required to reveal `children`. */
  feature: EntitlementKey;
  /** Rendered when the entitlement is missing. Defaults to nothing — paid
   * surfaces stay invisible on lower plans rather than advertising a lock. */
  fallback?: JSX.Element;
  children: JSX.Element;
}

/**
 * Conditionally renders gated UI based on the current entitlement source.
 *
 * The default source is the free-tier matrix. Supabase swaps in a
 * subscription-backed source after sign-in. Locked features render nothing
 * (product decision 2026-06-12): users on a lower plan shouldn't see
 * upgrade chrome for features their tier doesn't include.
 */
export const FeatureGate: Component<FeatureGateProps> = (props) => {
  const entitled = useEntitlement(props.feature);

  return (
    <Show when={entitled()} fallback={props.fallback ?? null}>
      {props.children}
    </Show>
  );
};
