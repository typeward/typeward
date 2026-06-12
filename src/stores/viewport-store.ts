import { createEffect, createRoot, createSignal, untrack } from "solid-js";

/**
 * Responsive layout state. Desktop keeps the 3-pane corvu Resizable;
 * tablet collapses to a single-pane stack with a segmented switcher.
 *
 * The breakpoint is intentionally generous — 1024px is the rough cutoff
 * where the 3-pane layout starts to feel cramped (sidebar 200px + center
 * 400px + preview 400px ≈ 1000px before chrome). Below that we want one
 * pane at a time on tablet form factors.
 */

export type ViewportMode = "desktop" | "tablet";
export type Pane = "sidebar" | "editor" | "preview";

const TABLET_BREAKPOINT = 1024;
const PANE_ORDER: Pane[] = ["sidebar", "editor", "preview"];

const readWidth = (): number => {
  if (typeof window === "undefined") return Infinity;
  return window.innerWidth;
};

const [viewportWidth, setViewportWidth] = createSignal(readWidth());
const [activePane, setActivePaneSig] = createSignal<Pane>("editor");
const [logsSheetOpen, setLogsSheetOpenSig] = createSignal(false);

export const viewportMode = (): ViewportMode =>
  viewportWidth() < TABLET_BREAKPOINT ? "tablet" : "desktop";

export const isTabletViewport = (): boolean => viewportMode() === "tablet";

export const setActivePane = (p: Pane): void => {
  setActivePaneSig(p);
};

export const cyclePane = (direction: 1 | -1): void => {
  // Clamp at the ends — wrap-around makes a forward swipe from "preview"
  // jump to the sidebar, which reads as a glitch on a 3-pane strip.
  const idx = PANE_ORDER.indexOf(activePane());
  const next = Math.min(Math.max(idx + direction, 0), PANE_ORDER.length - 1);
  setActivePaneSig(PANE_ORDER[next]);
};

export const setLogsSheetOpen = (v: boolean): void => {
  setLogsSheetOpenSig(v);
};
export const toggleLogsSheet = (): void => {
  setLogsSheetOpenSig(!logsSheetOpen());
};

export { activePane, logsSheetOpen, viewportWidth };

/**
 * Test-only helper to override the viewport width without resizing the
 * jsdom window. Production callers should never touch this.
 */
export const __setViewportWidthForTest = (w: number): void => {
  setViewportWidth(w);
};

if (typeof window !== "undefined") {
  createRoot(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });

    createEffect(() => {
      // Track only viewport transitions; untrack the open state so the
      // effect doesn't fire when the user toggles the sheet itself.
      const mode = viewportMode();
      if (mode === "desktop" && untrack(logsSheetOpen)) {
        setLogsSheetOpenSig(false);
      }
    });
  });
}
