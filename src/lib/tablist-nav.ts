/**
 * APG tabs keyboard pattern for the app's hand-rolled `role="tablist"` strips:
 * arrows move focus AND activate (selection follows focus), Home/End jump to
 * the edges, and a roving tabindex keeps exactly one tab in the Tab order
 * (the active tab is 0, the rest -1).
 *
 * Attach `handleTablistKeydown` to the tablist container's `onKeyDown` and put
 * `rovingTabIndex(active)` on each tab. Mirrors the file-tab strip's local
 * implementation in text-shell.tsx exactly; follow-up: swap that strip onto
 * this helper once its in-progress changes land.
 */

export function handleTablistKeydown(
  e: KeyboardEvent & { currentTarget: HTMLElement },
  opts: {
    count: number;
    activeIndex: number;
    activate: (index: number) => void;
  },
): void {
  const { count } = opts;
  if (count === 0) return;
  // A transiently hidden active tab (e.g. a gated tab dropping out before the
  // bounce-to-default effect runs) reports -1; treat it as the first tab so
  // arrows still land somewhere sensible.
  const current = opts.activeIndex < 0 ? 0 : opts.activeIndex;
  let next: number;
  if (e.key === "ArrowLeft") next = (current - 1 + count) % count;
  else if (e.key === "ArrowRight") next = (current + 1) % count;
  else if (e.key === "Home") next = 0;
  else if (e.key === "End") next = count - 1;
  else return;
  e.preventDefault();
  opts.activate(next);
  const tabs = e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
  tabs[next]?.focus();
}

export function rovingTabIndex(active: boolean): 0 | -1 {
  return active ? 0 : -1;
}
