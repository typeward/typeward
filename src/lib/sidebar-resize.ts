import { createEffect, createMemo, createSignal, onCleanup } from "solid-js";

interface SidebarResizeOptions {
  defaultPx?: number;
  minPx: number;
  maxPx: number;
  /**
   * Reactive content-fit width. While the user hasn't dragged the handle, the
   * sidebar tracks this (clamped) so it can size itself to its content — e.g.
   * the editor sidebar fitting its full tab strip. Returns `undefined` until a
   * measurement is available.
   */
  desiredPx?: () => number | undefined;
  /**
   * True while the resize handle is actually held down. When provided, this
   * is the sole drag discriminator: value comparison cannot tell a drag from
   * corvu echoing a programmatic size (mount, window reflow, min-clamp on
   * first paint), and boot echoes used to freeze auto-follow through exactly
   * that misread.
   */
  isDragging?: () => boolean;
}

// Stores the sidebar width in pixels (window-resize-independent) and projects
// it onto whatever the current container width is. Without this, corvu's
// fraction-based sizing lets px-bounded panels drift past their max whenever
// the window changes width, then snap back on the next drag.
export function createSidebarResize(opts: SidebarResizeOptions) {
  const { defaultPx = 260, minPx, maxPx, desiredPx, isDragging } = opts;
  const initialWindowWidth =
    typeof window !== "undefined" && window.innerWidth > 0
      ? window.innerWidth
      : 1280;

  const clamp = (px: number) => Math.min(maxPx, Math.max(minPx, px));

  const [sidebarPx, setSidebarPx] = createSignal(clamp(defaultPx));
  const [rootW, setRootW] = createSignal(initialWindowWidth);
  // Set once the user drags the handle; from then on we stop auto-following the
  // content-fit width so we never override an explicit choice.
  const [userAdjusted, setUserAdjusted] = createSignal(false);

  // The observed element lives inside a <Show> (focus mode unmounts/remounts
  // it), so (re)measure and (re)observe from the ref callback — which fires on
  // every (re)mount — rather than a one-shot onMount that would leave the
  // observer watching a stale, detached node after a focus round-trip.
  let ro: ResizeObserver | undefined;
  const setRef = (el: HTMLDivElement) => {
    ro?.disconnect();
    if (!el) return;
    const w = el.getBoundingClientRect().width;
    if (w > 0) setRootW(w);
    ro = new ResizeObserver((entries) => {
      const cw = entries[0]?.contentRect.width;
      if (cw && cw > 0) setRootW(cw);
    });
    ro.observe(el);
  };
  onCleanup(() => ro?.disconnect());

  // Follow the content-fit width until the user takes manual control.
  createEffect(() => {
    const d = desiredPx?.();
    if (d != null && d > 0 && !userAdjusted()) setSidebarPx(clamp(d));
  });

  const sizes = createMemo<number[]>(() => {
    const w = rootW();
    if (w <= 0) return [defaultPx / initialWindowWidth, 1 - defaultPx / initialWindowWidth];
    const clamped = clamp(sidebarPx());
    return [clamped / w, (w - clamped) / w];
  });

  const onSizesChange = (next: number[]) => {
    const w = rootW();
    if (w <= 0 || next[0] === undefined) return;
    const desired = next[0] * w;
    // Only a held-down handle makes a sizes report a drag. The old fallback
    // (compare against the current width with a 1px tolerance) misread mount
    // echoes that arrive before layout settles — corvu can report the panel's
    // min-clamped first paint — and froze auto-follow on boot.
    const dragging = isDragging
      ? isDragging()
      : Math.abs(desired - clamp(sidebarPx())) > 1;
    if (!dragging) return;
    setUserAdjusted(true);
    setSidebarPx(clamp(desired));
  };

  return { setRef, sizes, onSizesChange };
}
