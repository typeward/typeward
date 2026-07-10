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
