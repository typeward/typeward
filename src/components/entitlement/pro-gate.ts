import { setRequestProDialog } from "~/commands/palette-store";
import { PRO_DISCOVERY_ENABLED } from "~/config/pro";
import { hasEntitlement } from "~/integrations/entitlements";
import type { EntitlementKey } from "~/integrations/types";

/**
 * Click-through gate for locked Pro affordances. Returns true when the
 * action may proceed; otherwise opens the ProDialog and returns false —
 * never blocks with its own prompt (discovery amendment 2026-07-08).
 * While Pro discovery is off the dialog is unreachable, so the gate still
 * blocks but stays silent (the locked affordances are hidden anyway).
 */
export function proGate(key: EntitlementKey): boolean {
  if (hasEntitlement(key)) return true;
  if (PRO_DISCOVERY_ENABLED) setRequestProDialog(true);
  return false;
}
