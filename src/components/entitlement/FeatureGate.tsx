import type { Component, JSX } from "solid-js";
import { Show } from "solid-js";

import { useEntitlement } from "~/integrations/entitlements";
import type { EntitlementKey } from "~/integrations/types";
import { UpgradePrompt } from "./UpgradePrompt";

interface FeatureGateProps {
  /** Entitlement required to reveal `children`. */
  feature: EntitlementKey;
  /** Title shown in the upgrade fallback. */
  title?: string;
  /** One-line value prop shown in the upgrade fallback. */
  description?: string;
  /** Render NOTHING when the entitlement is missing, instead of a fallback. */
  hideWhenLocked?: boolean;
  /** Custom fallback. Wins over `hideWhenLocked` and the default `UpgradePrompt`. */
  fallback?: JSX.Element;
  children: JSX.Element;
}

/**
 * Conditionally renders gated UI based on the current entitlement source.
 *
 * Phase 0 ships with a stub source that approves everything — nothing is
 * actually locked yet. Phase 7 swaps the source and the same call sites
 * start showing fallbacks for free-tier users.
 */
export const FeatureGate: Component<FeatureGateProps> = (props) => {
  const entitled = useEntitlement(props.feature);

  return (
    <Show
      when={entitled()}
      fallback={
        props.hideWhenLocked
          ? null
          : (props.fallback ?? (
              <UpgradePrompt feature={props.feature} title={props.title} description={props.description} />
            ))
      }
    >
      {props.children}
    </Show>
  );
};
