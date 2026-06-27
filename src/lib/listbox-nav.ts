/**
 * Keyboard + focus support for the app's hand-rolled select popups (a trigger
 * button plus a `role="listbox"` container of `role="option"` buttons). These
 * controls predate any Kobalte Select adoption; rather than rewrite their glass
 * styling we layer the listbox interaction contract on top:
 *
 *   - `handleListboxKeydown` on the popup's `onKeyDown` roves focus among the
 *     options (Arrow/Home/End, wrapping) and closes on Escape.
 *   - `useListboxOpenFocus` (called once during component setup) moves focus
 *     onto the selected option — or the first — when the popup opens, so the
 *     arrow keys have a starting point and screen readers announce the list.
 *
 * Options are `tabindex={-1}` (focusable programmatically, skipped by Tab); the
 * buttons keep their native Enter/Space activation.
 */

import { createEffect } from "solid-js";

function optionsIn(container: HTMLElement | undefined): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>('[role="option"]'));
}

export function handleListboxKeydown(
  e: KeyboardEvent,
  container: HTMLElement | undefined,
  close: () => void,
): void {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  const opts = optionsIn(container);
  if (opts.length === 0) return;
  const idx = opts.indexOf(document.activeElement as HTMLElement);
  const move = (to: number) => {
    e.preventDefault();
    opts[(to + opts.length) % opts.length]?.focus();
  };
  switch (e.key) {
    case "ArrowDown":
      move(idx < 0 ? 0 : idx + 1);
      break;
    case "ArrowUp":
      move(idx < 0 ? opts.length - 1 : idx - 1);
      break;
    case "Home":
      move(0);
      break;
    case "End":
      move(opts.length - 1);
      break;
  }
}

export function useListboxOpenFocus(
  isOpen: () => boolean,
  getContainer: () => HTMLElement | undefined,
): void {
  createEffect(() => {
    if (!isOpen()) return;
    requestAnimationFrame(() => {
      const opts = optionsIn(getContainer());
      const selected = opts.find((o) => o.getAttribute("aria-selected") === "true");
      (selected ?? opts[0])?.focus();
    });
  });
}
