/**
 * Pure viewport-clamp math for fixed-position menus, extracted from
 * `ContextMenu` so it's unit-testable without a DOM. Keeps the menu `pad` px
 * clear of the right/bottom edges, never pushes it past the top-left pad, and
 * leaves the requested position untouched when it already fits.
 */

export interface MenuPositionInput {
  x: number;
  y: number;
  menuWidth: number;
  menuHeight: number;
  viewportWidth: number;
  viewportHeight: number;
  /** Minimum gap to the viewport edges, in px. */
  pad?: number;
}

export function clampMenuPosition(input: MenuPositionInput): {
  x: number;
  y: number;
} {
  const pad = input.pad ?? 8;
  let x = input.x;
  let y = input.y;
  if (x + input.menuWidth > input.viewportWidth - pad)
    x = Math.max(pad, input.viewportWidth - input.menuWidth - pad);
  if (y + input.menuHeight > input.viewportHeight - pad)
    y = Math.max(pad, input.viewportHeight - input.menuHeight - pad);
  return { x, y };
}

export function isMenuKey(e: KeyboardEvent): boolean {
  return e.key === "ContextMenu" || (e.key === "F10" && e.shiftKey);
}

// Keyboard menu invocation has no cursor; the element's bottom-left corner
// stands in for the mouse position `createContextMenuState().openAt` expects.
export function menuEventAtRect(el: HTMLElement): MouseEvent {
  const r = el.getBoundingClientRect();
  return new MouseEvent("contextmenu", { clientX: r.left, clientY: r.bottom });
}

// Some platforms deliver the ContextMenu key as a contextmenu EVENT with no
// usable position ((0,0) coordinates, or detail 0 without a right-button
// press); re-anchor those at the invoking element instead of the window corner.
export function anchoredMenuEvent(
  e: MouseEvent & { currentTarget: HTMLElement },
): MouseEvent {
  const keyboardLike =
    (e.clientX === 0 && e.clientY === 0) || (e.detail === 0 && e.button !== 2);
  if (!keyboardLike) return e;
  // openAt() only cancels the event it receives — suppress the original here
  // so the native menu stays off and sibling handlers don't also fire.
  e.preventDefault();
  e.stopPropagation();
  return menuEventAtRect(e.currentTarget);
}
