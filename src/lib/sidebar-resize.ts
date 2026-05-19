import { createMemo, createSignal, onCleanup, onMount } from "solid-js";

interface SidebarResizeOptions {
  defaultPx?: number;
  minPx: number;
  maxPx: number;
}

// Stores the sidebar width in pixels (window-resize-independent) and projects
// it onto whatever the current container width is. Without this, corvu's
// fraction-based sizing lets px-bounded panels drift past their max whenever
// the window changes width, then snap back on the next drag.
export function createSidebarResize(opts: SidebarResizeOptions) {
  const { defaultPx = 260, minPx, maxPx } = opts;
  const initialWindowWidth =
    typeof window !== "undefined" && window.innerWidth > 0
      ? window.innerWidth
      : 1280;

  const [sidebarPx, setSidebarPx] = createSignal(
    Math.min(maxPx, Math.max(minPx, defaultPx)),
  );
  const [rootW, setRootW] = createSignal(initialWindowWidth);

  let rootEl: HTMLDivElement | undefined;
  const setRef = (el: HTMLDivElement) => {
    rootEl = el;
  };

  onMount(() => {
    if (!rootEl) return;
    const measure = () => {
      const w = rootEl!.getBoundingClientRect().width;
      if (w > 0) setRootW(w);
    };
    measure();
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (w && w > 0) setRootW(w);
    });
    ro.observe(rootEl);
    onCleanup(() => ro.disconnect());
  });

  const sizes = createMemo<number[]>(() => {
    const w = rootW();
    if (w <= 0) return [defaultPx / initialWindowWidth, 1 - defaultPx / initialWindowWidth];
    const clamped = Math.min(maxPx, Math.max(minPx, sidebarPx()));
    return [clamped / w, (w - clamped) / w];
  });

  const onSizesChange = (next: number[]) => {
    const w = rootW();
    if (w <= 0 || next[0] === undefined) return;
    const desired = next[0] * w;
    setSidebarPx(Math.min(maxPx, Math.max(minPx, desired)));
  };

  return { setRef, sizes, onSizesChange };
}
