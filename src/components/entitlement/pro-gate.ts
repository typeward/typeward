import { setRequestProDialog } from "~/commands/palette-store";
import { hasEntitlement } from "~/integrations/entitlements";
import type { EntitlementKey } from "~/integrations/types";

/**
 * Click-through gate for locked Pro affordances. Returns true when the
 * action may proceed; otherwise opens the ProDialog and returns false —
 * never blocks with its own prompt (discovery amendment 2026-07-08).
 */
export function proGate(key: EntitlementKey): boolean {
  if (hasEntitlement(key)) return true;
  setRequestProDialog(true);
  return false;
}
