import { onCleanup } from "solid-js";

/**
 * Click-outside + Escape dismissal for hand-rolled popovers (the Kobalte
 * primitives handle this themselves). Call once during component setup;
 * listeners live for the component lifetime and gate on `isOpen`, so the
 * closed-state cost is one boolean check per click/keydown.
 *
 * Escape stops propagation so the global keyboard router doesn't also act
 * on it while a popover is open.
 */
export function installDismiss(
  root: () => HTMLElement | undefined,
  isOpen: () => boolean,
  close: () => void,
  options?: {
    /**
     * CSS selector for elements that should NOT count as "outside" — e.g. the
     * toggle button that opens the popover, so its own click doesn't close +
     * immediately reopen via its own handler.
     */
    ignoreSelector?: string;
  },
): void {
  const onPointerDown = (e: MouseEvent) => {
    if (!isOpen()) return;
    const target = e.target as HTMLElement | null;
    if (options?.ignoreSelector && target?.closest(options.ignoreSelector)) {
      return;
    }
    const el = root();
    if (el && target && !el.contains(target)) close();
  };
  const onKeyDown = (e: KeyboardEvent) => {
    if (!isOpen() || e.key !== "Escape") return;
    e.stopPropagation();
    close();
  };
  document.addEventListener("mousedown", onPointerDown);
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => {
    document.removeEventListener("mousedown", onPointerDown);
    document.removeEventListener("keydown", onKeyDown);
  });
}
