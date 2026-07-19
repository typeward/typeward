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
export type PaneTier = "three" | "two" | "one";

const TABLET_BREAKPOINT = 1024;
const TWO_PANE_MIN = 800;
const PANE_ORDER: Pane[] = ["sidebar", "editor", "preview"];
const COARSE_POINTER_QUERY = "(pointer: coarse)";

const readWidth = (): number => {
  if (typeof window === "undefined") return Infinity;
  return window.innerWidth;
};

// Guarded like theme-store's system-dark query — jsdom's matchMedia support
// is minimal/absent, and importing this store in Vitest must never throw.
const coarsePointerQuery: MediaQueryList | null =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia(COARSE_POINTER_QUERY)
    : null;

const [viewportWidth, setViewportWidth] = createSignal(readWidth());
const [coarsePointer, setCoarsePointer] = createSignal(
  coarsePointerQuery?.matches ?? false,
);
const [activePane, setActivePaneSig] = createSignal<Pane>("editor");
const [logsSheetOpen, setLogsSheetOpenSig] = createSignal(false);

export const viewportMode = (): ViewportMode =>
  viewportWidth() < TABLET_BREAKPOINT ? "tablet" : "desktop";

export const isTabletViewport = (): boolean => viewportMode() === "tablet";

/**
 * Primary input is coarse (touch/pen) per the CSS `pointer` media feature.
 * Reactive — flips live when e.g. a convertible detaches its keyboard.
 */
export const isCoarsePointer = (): boolean => coarsePointer();

/**
 * The intent name touch-sizing consumers use (finding #17: keying tap-target
 * bumps on width alone gave landscape iPads the 24px desktop targets). Today
 * this is exactly pointer coarseness; it may later OR in a settings override
 * without touching call sites.
 */
export const touchAffordances = (): boolean => isCoarsePointer();

/**
 * How many panes fit side by side — derived from the same width signal as
 * viewportMode. "one" is the single-pane stack activePane/cyclePane serve.
 */
export const paneTier = (): PaneTier => {
  const w = viewportWidth();
  if (w >= TABLET_BREAKPOINT) return "three";
  return w >= TWO_PANE_MIN ? "two" : "one";
};

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

/** Test-only pointer-coarseness override — same contract as the width one. */
export const __setCoarsePointerForTest = (v: boolean): void => {
  setCoarsePointer(v);
};

if (typeof window !== "undefined") {
  createRoot(() => {
    const onResize = () => setViewportWidth(window.innerWidth);
    window.addEventListener("resize", onResize, { passive: true });

    // Optional-chained like theme-store's dark-query listener — older
    // webviews/jsdom expose MediaQueryList without addEventListener.
    coarsePointerQuery?.addEventListener?.("change", (e) => {
      setCoarsePointer(e.matches);
    });

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
