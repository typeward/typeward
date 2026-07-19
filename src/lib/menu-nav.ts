/**
 * Keyboard + focus support for the app's hand-rolled command menus (a trigger
 * button plus a `role="menu"` container of `role="menuitem"` buttons) — the
 * APG menu-button pattern. Sibling of `listbox-nav.ts`, which covers the
 * persistent-selection popups; these menus fire one-shot actions, so their
 * items carry no `aria-selected`:
 *
 *   - `handleMenuKeydown` on the popup's `onKeyDown` roves focus among the
 *     items (Arrow/Home/End, wrapping) and closes on Escape.
 *   - `useMenuOpenFocus` (called once during component setup) moves focus onto
 *     the first item when the menu opens, so the arrow keys have a starting
 *     point and screen readers announce the menu. On close it hands focus back
 *     to the pre-open element (the trigger) — the popup unmounts, so without
 *     the restore focus would fall to <body>.
 *
 * The trigger should carry `aria-haspopup="menu"` + `aria-expanded`. Items are
 * `tabindex={-1}` (focusable programmatically, skipped by Tab); the buttons
 * keep their native Enter/Space activation.
 */

import { createEffect } from "solid-js";

function itemsIn(container: HTMLElement | undefined): HTMLElement[] {
  if (!container) return [];
  // Disabled items can't take focus — including them would make the
  // open-focus and arrow-roving silently no-op on them.
  return Array.from(
    container.querySelectorAll<HTMLElement>('[role="menuitem"]'),
  ).filter((o) => !o.hasAttribute("disabled") && o.getAttribute("aria-disabled") !== "true");
}

export function handleMenuKeydown(
  e: KeyboardEvent,
  container: HTMLElement | undefined,
  close: () => void,
): void {
  if (e.key === "Escape") {
    e.preventDefault();
    close();
    return;
  }
  // APG menu pattern: Tab dismisses. Items are tabindex=-1, so without this
  // the focus walks out while the popup stays open with aria-expanded=true.
  if (e.key === "Tab") {
    close();
    return;
  }
  const items = itemsIn(container);
  if (items.length === 0) return;
  const idx = items.indexOf(document.activeElement as HTMLElement);
  const move = (to: number) => {
    e.preventDefault();
    items[(to + items.length) % items.length]?.focus();
  };
  switch (e.key) {
    case "ArrowDown":
      move(idx < 0 ? 0 : idx + 1);
      break;
    case "ArrowUp":
      move(idx < 0 ? items.length - 1 : idx - 1);
      break;
    case "Home":
      move(0);
      break;
    case "End":
      move(items.length - 1);
      break;
  }
}

export function useMenuOpenFocus(
  isOpen: () => boolean,
  getContainer: () => HTMLElement | undefined,
): void {
  let restoreTo: HTMLElement | null = null;
  createEffect(() => {
    if (!isOpen()) {
      // Restore only when focus is still inside the (unmounting) popup or
      // already fell to <body> — an outside-click dismissal that focused
      // something else (e.g. the CodeMirror document) must keep its focus.
      const active = document.activeElement;
      const container = getContainer();
      const focusIsLoose =
        active === document.body ||
        active === null ||
        (container instanceof HTMLElement && container.contains(active));
      if (focusIsLoose && restoreTo?.isConnected) restoreTo.focus();
      restoreTo = null;
      return;
    }
    restoreTo =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : null;
    requestAnimationFrame(() => {
      itemsIn(getContainer())[0]?.focus();
    });
  });
}
