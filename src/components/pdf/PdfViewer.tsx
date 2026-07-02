import { describeIpcError } from "~/lib/errors";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  ChevronDown,
  ChevronUp,
  Loader2,
  Play,
  Sparkles,
  Terminal,
  ZoomIn,
} from "lucide-solid";
import * as pdfjs from "pdfjs-dist";
// Vite-resolves the worker file to a URL and serves it as a separate chunk.
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import type { Component } from "solid-js";
import { For, Show, createEffect, createSignal, on, onCleanup } from "solid-js";
import { AiView } from "~/components/editor/AiView";
import { ExportMenu } from "~/components/editor/ExportMenu";
import { LogsView } from "~/components/editor/LogsDrawer";
import { KbdHint } from "~/components/primitives/KbdHint";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { integrationsSettings } from "~/stores/settings-store";
import { isTabletViewport } from "~/stores/viewport-store";
import {
  animations,
  consolePosition,
  previewMode,
  setPreviewMode,
} from "~/stores/ui-store";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type RenderTask = ReturnType<pdfjs.PDFPageProxy["render"]>;

interface PdfViewerProps {
  /** Absolute path on disk. Reloaded whenever it changes (or version bumps). */
  path: string | null;
  /** Bump to force a reload while keeping the same path (after a recompile). */
  version?: number;
  /** Triggered when the user clicks the toolbar Recompile button. */
  onCompile?: () => void;
  /** Whether a compile is currently running (drives the button state). */
  compiling?: boolean;
  /**
   * Inverse-search hook. Fires when the user clicks (or shift-clicks,
   * depending on the parent's policy) on a page. `x` and `y` are in PDF
   * points relative to that page's top-left corner — exactly what
   * `synctex edit` expects.
   */
  onPageClick?: (page: number, x: number, y: number) => void;
  /**
   * Forward-search target. When this signal changes, scroll to (page, y).
   * `y` is in PDF points from the top of that page; the viewer converts
   * to CSS pixels using the current zoom scale. A non-null `generation`
   * field guarantees re-firing on identical (page, y) repeats.
   */
  scrollTarget?: { page: number; y: number; generation: number } | null;
}

const ZOOM_PRESETS = [50, 75, 90, 100, 110, 125, 150, 175, 200] as const;

/** Pre-render this many CSS px above/below the viewport so a quick scroll
 *  doesn't reveal blank pages before they paint. */
const RENDER_MARGIN_PX = 800;

interface PageSlot {
  /** The canvas host (absolute inset-0 of the page box) the render mounts into. */
  host: HTMLElement;
  task: RenderTask | null;
  canvas: HTMLCanvasElement | null;
  /** Scale the current canvas was rendered at; null when nothing is mounted. */
  renderedScale: number | null;
}

/**
 * Toolbar ported from `design_files/Editor.html` PdfPreview (line 7741+):
 *   - Recompile (hero, accent-grad, ⌘↵ kbd)
 *   - Page nav with current/total
 *   - Zoom dropdown
 *   - Download
 *
 * Pages stack vertically. Rendering is virtualized: every page gets a
 * placeholder sized to its real dimensions (so the scrollbar + scroll
 * positions are correct), but only pages near the viewport own a rendered
 * canvas. Off-screen canvases are released to bound memory — a 300pp thesis
 * at dpr 2-3 would otherwise allocate hundreds of MB and OOM mobile webviews.
 * Scroll position and zoom are retained across recompiles.
 */
export const PdfViewer: Component<PdfViewerProps> = (props) => {
  let scrollEl: HTMLDivElement | undefined;
  let zoomRef: HTMLDivElement | undefined;
  // Unscaled (scale=1) page dimensions in PDF points; placeholder CSS size is
  // these times the current zoom scale. Drives the layout + scrollbar.
  const [pageSizes, setPageSizes] = createSignal<{ w: number; h: number }[]>([]);
  const [scale, setScale] = createSignal(1.1);
  const [zoomOpen, setZoomOpen] = createSignal(false);

  installDismiss(() => zoomRef, zoomOpen, () => setZoomOpen(false));
  useListboxOpenFocus(zoomOpen, () => zoomRef);

  const scrollBehavior = (): ScrollBehavior =>
    !animations() ||
    (typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      ? "auto"
      : "smooth";

  // AI master switch. When it flips off while the chat is showing, fall
  // back to the PDF so the pane never strands on a hidden mode.
  const aiEnabled = () => integrationsSettings().ai.enabled;
  createEffect(() => {
    if (!aiEnabled() && previewMode() === "ai") setPreviewMode("pdf");
  });
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);
  const [currentPage, setCurrentPage] = createSignal(1);
  const [highlight, setHighlight] = createSignal<
    { page: number; yCss: number } | null
  >(null);
  let savedScrollTop = 0;
  // Captured at the moment a zoom starts so the content under the viewport top
  // stays put across the reflow (scrollTop is in CSS px, which the zoom scales).
  let zoomAnchorTop = 0;
  let zoomAnchorScale = scale();
  let docRef: pdfjs.PDFDocumentProxy | null = null;
  // v6 removed PDFDocumentProxy.destroy(); teardown now goes through the
  // loading task. We keep both: docRef (proxy) for getPage/re-render, taskRef
  // (loading task) to destroy the doc + release the worker.
  let taskRef: pdfjs.PDFDocumentLoadingTask | null = null;
  // Bumps on every load() / path change. Older async chains compare this to
  // their captured `gen` after each await and bail if superseded — without it
  // a slow load completing after a newer one wipes the screen.
  let loadGen = 0;
  // Path of the last successfully-wired document — gates the recompile fast
  // path in load() (same path + same layout keeps old canvases on screen).
  let lastLoadedPath: string | null = null;

  // Per-page render registry (imperative, non-reactive). Keyed by 1-based page
  // number. Page proxies are cached for re-render; `visible` tracks which pages
  // the observer currently considers in-or-near the viewport.
  const slots = new Map<number, PageSlot>();
  const pageProxies = new Map<number, pdfjs.PDFPageProxy>();
  const visible = new Set<number>();
  let observer: IntersectionObserver | null = null;

  const isCancellation = (e: unknown): boolean =>
    !!e &&
    typeof e === "object" &&
    (e as { name?: string }).name === "RenderingCancelledException";

  // Cap device-pixel-ratio on small/touch viewports — full dpr on a 3× phone
  // panel is the OOM lever; 2× is visually indistinguishable at those sizes.
  const renderDpr = (): number =>
    Math.min(window.devicePixelRatio || 1, isTabletViewport() ? 2 : 3);

  const getPage = async (n: number): Promise<pdfjs.PDFPageProxy | null> => {
    let p = pageProxies.get(n);
    if (!p) {
      if (!docRef) return null;
      p = await docRef.getPage(n);
      pageProxies.set(n, p);
    }
    return p;
  };

  const renderPage = async (pageNum: number) => {
    const slot = slots.get(pageNum);
    if (!slot || !docRef) return;
    const s = scale();
    if (slot.renderedScale === s && slot.canvas) return;
    // Supersede any in-flight render for this page (e.g. a zoom mid-render).
    slot.task?.cancel();
    slot.task = null;
    const gen = loadGen;
    try {
      const page = await getPage(pageNum);
      if (!page || gen !== loadGen || s !== scale() || !slots.has(pageNum)) {
        return;
      }
      const viewport = page.getViewport({ scale: s });
      const dpr = renderDpr();
      const canvas = document.createElement("canvas");
      canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
      canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
      canvas.style.width = "100%";
      canvas.style.height = "100%";
      canvas.style.display = "block";
      const ctx = canvas.getContext("2d");
      if (!ctx) return;
      ctx.scale(dpr, dpr);
      const task = page.render({ canvasContext: ctx, viewport, canvas });
      slot.task = task;
      await task.promise;
      // Discard if the doc/scale moved on, the slot was torn down, or the page
      // scrolled out of the buffer while we rendered.
      if (
        gen !== loadGen ||
        s !== scale() ||
        !slots.has(pageNum) ||
        !visible.has(pageNum)
      ) {
        canvas.width = 0;
        canvas.height = 0;
        return;
      }
      if (slot.canvas) {
        slot.canvas.width = 0;
        slot.canvas.height = 0;
      }
      slot.host.replaceChildren(canvas);
      slot.canvas = canvas;
      slot.renderedScale = s;
      slot.task = null;
    } catch (e) {
      if (isCancellation(e)) return;
      // Swallow per-page render failures — keep the rest of the document
      // intact rather than blanking the whole viewer on one bad page. But a
      // slot whose renderedScale was nulled (recompile fast path) still holds
      // the PREVIOUS document's bitmap: blank it rather than show stale pages
      // next to fresh ones.
      const cur = slots.get(pageNum);
      if (cur?.canvas && cur.renderedScale === null) unrenderPage(pageNum);
    }
  };

  const unrenderPage = (pageNum: number) => {
    const slot = slots.get(pageNum);
    if (!slot) return;
    slot.task?.cancel();
    slot.task = null;
    if (slot.canvas) {
      slot.canvas.width = 0;
      slot.canvas.height = 0;
      slot.host.replaceChildren();
      slot.canvas = null;
    }
    slot.renderedScale = null;
    // Release the page's re-fetchable operator-list cache (not the proxy
    // itself) to bound memory on a long scroll through a large doc. pdf.js
    // no-ops this while a render is in flight and rebuilds it on the next
    // render(), so re-entry still paints correctly.
    pageProxies.get(pageNum)?.cleanup();
  };

  // Clear all slots ahead of a fresh load. Unobserves (rather than
  // disconnecting) so the single observer instance stays alive for the
  // component's life; the about-to-be-replaced rows still get a per-row
  // onCleanup pass when Solid disposes them.
  const resetSlots = () => {
    for (const slot of slots.values()) {
      observer?.unobserve(slot.host);
      slot.task?.cancel();
      if (slot.canvas) {
        slot.canvas.width = 0;
        slot.canvas.height = 0;
      }
    }
    slots.clear();
    visible.clear();
  };

  const onIntersect: IntersectionObserverCallback = (entries) => {
    for (const entry of entries) {
      const pageNum = Number((entry.target as HTMLElement).dataset.pidx);
      if (!pageNum || !slots.has(pageNum)) continue;
      if (entry.isIntersecting) {
        visible.add(pageNum);
        void renderPage(pageNum);
      } else {
        visible.delete(pageNum);
        unrenderPage(pageNum);
      }
    }
  };

  // Ref on the scroll container. It's the IntersectionObserver root and mounts
  // exactly once (the AI/console panes overlay it rather than unmounting it),
  // so the observer + slots stay stable across preview-mode switches.
  const setScrollEl = (el: HTMLDivElement) => {
    scrollEl = el;
    observer?.disconnect();
    observer = new IntersectionObserver(onIntersect, {
      root: el,
      rootMargin: `${RENDER_MARGIN_PX}px 0px`,
      threshold: 0,
    });
    for (const slot of slots.values()) observer.observe(slot.host);
  };

  const registerPage = (pageNum: number, host: HTMLElement) => {
    const slot: PageSlot = {
      host,
      task: null,
      canvas: null,
      renderedScale: null,
    };
    slots.set(pageNum, slot);
    observer?.observe(host);
    // Self-clean when Solid disposes this row (new/smaller doc, path cleared,
    // load error). The guarded delete prevents a stale teardown from evicting
    // a freshly re-registered slot for the same page number.
    onCleanup(() => {
      observer?.unobserve(host);
      slot.task?.cancel();
      if (slot.canvas) {
        slot.canvas.width = 0;
        slot.canvas.height = 0;
      }
      visible.delete(pageNum);
      if (slots.get(pageNum) === slot) slots.delete(pageNum);
    });
  };

  const load = async (path: string) => {
    const gen = ++loadGen;
    setLoading(true);
    setErr(null);
    let task: pdfjs.PDFDocumentLoadingTask | null = null;
    try {
      const bytes = await readFile(path);
      if (gen !== loadGen) return;
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      task = pdfjs.getDocument({ data: buf });
      const doc = await task.promise;
      if (gen !== loadGen) {
        task.destroy();
        return;
      }
      // Page proxies are cheap (no rasterization); fetching them up front gives
      // every placeholder its true size so the scrollbar + scroll math are
      // correct before a single canvas is drawn. Deliberately done BEFORE any
      // teardown of the mounted canvases: the old document must stay visible
      // through the worker round-trip or every recompile flashes white.
      const proxies = await Promise.all(
        Array.from({ length: doc.numPages }, (_, i) => doc.getPage(i + 1)),
      );
      if (gen !== loadGen) {
        task.destroy();
        return;
      }
      const dims = proxies.map((p) => {
        const vp = p.getViewport({ scale: 1 });
        return { w: vp.width, h: vp.height };
      });
      const prevTask = taskRef;
      taskRef = task;
      docRef = doc;
      pageProxies.clear();
      proxies.forEach((p, i) => pageProxies.set(i + 1, p));

      const prev = pageSizes();
      const sameLayout =
        path === lastLoadedPath &&
        dims.length === prev.length &&
        dims.every((d, i) => d.w === prev[i].w && d.h === prev[i].h);
      if (sameLayout) {
        // Recompile fast path: identical page geometry, so keep the <For>
        // rows AND the mounted canvases. Nulling renderedScale defeats
        // renderPage's same-scale early return; renderPage then swaps each
        // canvas via replaceChildren only after the new page has rasterized,
        // so the old bitmap stays on screen the whole time (double-buffer).
        // The observer won't re-fire for unchanged intersections — re-render
        // the visible set imperatively, mirroring the zoom effect.
        for (const slot of slots.values()) slot.renderedScale = null;
        for (const pageNum of [...visible]) void renderPage(pageNum);
      } else {
        resetSlots();
        setPageSizes(dims);
        requestAnimationFrame(() => {
          if (scrollEl) scrollEl.scrollTop = savedScrollTop;
        });
      }
      lastLoadedPath = path;
      prevTask?.destroy();
    } catch (e) {
      // A task created but never wired into taskRef has no other owner —
      // destroy it here or its document + dedicated worker leak on every
      // failed load (e.g. getPage rejecting on a truncated PDF).
      if (task && taskRef !== task) task.destroy();
      if (gen !== loadGen) return;
      // PDF.js throws this when an in-flight render is replaced by a newer
      // one — expected during quick recompile sequences, not a failure.
      if (isCancellation(e)) return;
      setErr(describeIpcError(e));
      setPageSizes([]);
    } finally {
      if (gen === loadGen) setLoading(false);
    }
  };

  // Initial + path changes: reload the doc.
  createEffect(
    on(
      () => [props.path, props.version ?? 0] as const,
      ([path]) => {
        savedScrollTop = scrollEl?.scrollTop ?? 0;
        if (!path) {
          ++loadGen;
          lastLoadedPath = null;
          resetSlots();
          pageProxies.clear();
          setPageSizes([]);
          return;
        }
        void load(path);
      },
    ),
  );

  // Zoom changes: the placeholder sizes update reactively (they read scale()),
  // so the layout reflows on its own; here we anchor the scroll position to the
  // pre-zoom content and re-render the pages currently in the buffer.
  createEffect(
    on(
      scale,
      (s) => {
        if (!docRef) return;
        if (scrollEl && zoomAnchorScale > 0) {
          scrollEl.scrollTop = zoomAnchorTop * (s / zoomAnchorScale);
        }
        for (const pageNum of [...visible]) void renderPage(pageNum);
      },
      { defer: true },
    ),
  );

  const applyZoom = (z: number) => {
    zoomAnchorTop = scrollEl?.scrollTop ?? 0;
    zoomAnchorScale = scale();
    setScale(z / 100);
    setZoomOpen(false);
  };

  // Forward-search: scroll to (page, y) and pulse a highlight ribbon. The
  // scroll container is the page boxes' offsetParent (it's positioned), so
  // offsetTop maps straight into scrollTop space.
  createEffect(
    on(
      () => props.scrollTarget?.generation ?? 0,
      () => {
        const t = props.scrollTarget;
        if (!t || !scrollEl) return;
        const pageEl = scrollEl.querySelector<HTMLElement>(
          `[data-page="${t.page}"]`,
        );
        if (!pageEl) return;
        const yCss = t.y * scale();
        // Offset by ~60px so the target sits below any sticky chrome and
        // isn't kissing the top edge of the viewport.
        scrollEl.scrollTo({
          top: Math.max(0, pageEl.offsetTop + yCss - 60),
          behavior: scrollBehavior(),
        });
        setCurrentPage(t.page);
        setHighlight({ page: t.page, yCss });
        window.setTimeout(() => setHighlight((h) =>
          h && h.page === t.page && h.yCss === yCss ? null : h,
        ), 1600);
      },
      { defer: true },
    ),
  );

  // Inverse search fires on double-click (double-tap on touch) — the
  // natural "take me to this" gesture — with shift+click kept as the
  // power-user shortcut. Plain single clicks stay free for text
  // selection / pan affordances.
  const triggerInverseSearch = (e: MouseEvent, pageNum: number) => {
    if (!props.onPageClick) return;
    // currentTarget is the page box, sized exactly to the page in CSS px.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    if (xPx < 0 || yPx < 0 || xPx > rect.width || yPx > rect.height) return;
    const s = scale();
    e.preventDefault();
    props.onPageClick(pageNum, xPx / s, yPx / s);
  };

  const handlePageClick = (e: MouseEvent, pageNum: number) => {
    if (!e.shiftKey) return;
    triggerInverseSearch(e, pageNum);
  };

  onCleanup(() => {
    observer?.disconnect();
    for (const slot of slots.values()) slot.task?.cancel();
    taskRef?.destroy();
  });

  const totalPages = () => pageSizes().length;

  const setPage = (n: number) => {
    if (!scrollEl) return;
    const clamped = Math.max(1, Math.min(totalPages(), n));
    setCurrentPage(clamped);
    const el = scrollEl.querySelector<HTMLElement>(`[data-page="${clamped}"]`);
    if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  };

  const fileName = () =>
    props.path ? props.path.split(/[\\/]/).pop() ?? "" : "";

  return (
    <div class="relative flex h-full min-w-0 flex-col overflow-hidden">
      {/* Toolbar — 44px. Layout per /design/screens-editor.md (updated 2026-05-15):
            [Recompile] [Export icon] [Logs/Console icon] [AI icon]   …   [page nav] [zoom]
          Icon-only toggles (with `title` tooltips); the Logs/Console icon
          only renders when console position is "in PDF panel". The Recompile
          button keeps its label because it's the primary action. */}
      <div class="@container flex h-[44px] flex-shrink-0 items-center gap-1 border-b border-glass-stroke px-2.5">
        <button
          type="button"
          onClick={() => props.onCompile?.()}
          disabled={props.compiling}
          class="lift glow-accent relative flex h-8 items-center gap-2 rounded-lg accent-grad pl-3 pr-2.5 text-sm font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Show
            when={props.compiling}
            fallback={<Play size={12} stroke-width={2.2} />}
          >
            <Loader2 size={12} class="animate-spin" />
          </Show>
          <span>{props.compiling ? "Compiling…" : "Recompile"}</span>
          {/* KbdHint hides itself on tablet; the Show keeps the empty ml-1
              wrapper from leaving phantom trailing space in the button. */}
          <Show when={!isTabletViewport()}>
            <span class="ml-1 hidden @[28rem]:inline-flex">
              <KbdHint shortcut="Mod+Enter" size="md" tone="dark" />
            </span>
          </Show>
        </button>

        <ExportMenu pdfPath={props.path} />

        <Show when={consolePosition() === "pdf-tab"}>
          <ToolbarIconToggle
            active={previewMode() === "console"}
            onClick={() =>
              setPreviewMode(previewMode() === "console" ? "pdf" : "console")
            }
            icon={<Terminal size={16} />}
            label="Logs"
          />
        </Show>

        <Show when={aiEnabled()}>
          <ToolbarIconToggle
            active={previewMode() === "ai"}
            onClick={() => setPreviewMode(previewMode() === "ai" ? "pdf" : "ai")}
            icon={<Sparkles size={16} />}
            label="AI"
          />
        </Show>


        <Show when={loading() && previewMode() === "pdf"}>
          <Loader2 size={12} class="ml-2 animate-spin text-fg-3" />
        </Show>
        <Show when={fileName() && !loading() && previewMode() === "pdf"}>
          <span class="mono ml-2 truncate text-xs text-fg-3">
            {fileName()}
          </span>
        </Show>

        <div class="ml-auto flex items-center gap-1.5">
          <Show when={previewMode() === "pdf"}>
            {/* Page nav */}
            <div class="glass-inset flex items-center gap-1 rounded-md p-0.5">
              <button
                type="button"
                onClick={() => setPage(currentPage() - 1)}
                disabled={totalPages() === 0 || currentPage() <= 1}
                class="lift flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)] disabled:opacity-40"
                title="Previous page"
                aria-label="Previous page"
              >
                <ChevronUp size={12} class="opacity-70" />
              </button>
              <div class="mono flex items-center gap-1 px-2 text-xs">
                <span class="font-medium text-fg-1">
                  {totalPages() === 0 ? "—" : currentPage()}
                </span>
                <span class="text-fg-4">/</span>
                <span class="text-fg-2">{totalPages() === 0 ? "—" : totalPages()}</span>
              </div>
              <button
                type="button"
                onClick={() => setPage(currentPage() + 1)}
                disabled={totalPages() === 0 || currentPage() >= totalPages()}
                class="lift flex h-6 w-6 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)] disabled:opacity-40"
                title="Next page"
                aria-label="Next page"
              >
                <ChevronDown size={12} class="opacity-70" />
              </button>
            </div>

            {/* Zoom dropdown — rightmost element per updated layout */}
            <div class="relative" ref={zoomRef}>
              <button
                type="button"
                onClick={() => setZoomOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={zoomOpen()}
                title="Zoom"
                class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-sm"
              >
                <ZoomIn size={12} class="opacity-70" />
                <span class="mono hidden min-w-[58px] text-left text-fg-1 @[28rem]:inline">
                  {Math.round(scale() * 100)}%
                </span>
                <ChevronDown size={10} class="opacity-50" />
              </button>
              <Show when={zoomOpen()}>
                <div
                  role="listbox"
                  tabindex={-1}
                  onKeyDown={(e) => handleListboxKeydown(e, zoomRef, () => setZoomOpen(false))}
                  class="glass absolute right-0 z-40 mt-1 w-[140px] overflow-hidden rounded-md py-1"
                  style={{ background: "var(--color-popover-bg)" }}
                >
                  <For each={ZOOM_PRESETS}>
                    {(z) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={Math.round(scale() * 100) === z}
                        tabindex={-1}
                        onClick={() => applyZoom(z)}
                        class={`flex h-7 w-full items-center px-3 text-left text-sm hover:bg-[var(--color-control-fill)] ${
                          Math.round(scale() * 100) === z
                            ? "text-fg-1 font-medium"
                            : "text-fg-2"
                        }`}
                      >
                        {z}%
                      </button>
                    )}
                  </For>
                </div>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <Show when={err() && previewMode() === "pdf"}>
        <div class="select-text px-3 py-2 text-xs text-[var(--color-err)]">{err()}</div>
      </Show>

      {/* Content area. The PDF scroll container stays mounted at all times so
          the IntersectionObserver root + per-page slots survive preview-mode
          switches; the AI / console panes overlay it and the scroll container
          hides via display:none (which also frees its canvases while away). */}
      <div class="relative min-h-0 flex-1 overflow-hidden">
        <Show when={previewMode() === "ai"}>
          <div class="absolute inset-0 overflow-hidden">
            <AiView />
          </div>
        </Show>
        <Show when={previewMode() === "console"}>
          <div class="absolute inset-0 overflow-hidden">
            <LogsView />
          </div>
        </Show>
        {/* `scrollbar-gutter: stable` reserves the scrollbar's width so
            toggling PDF / Logs / AI never reflows the pane. */}
        <div
          ref={setScrollEl}
          class="scroll absolute inset-0 overflow-auto"
          style={{
            background: "var(--color-overlay-dim)",
            "scrollbar-gutter": "stable",
            display: previewMode() === "pdf" ? undefined : "none",
          }}
        >
          <Show
            when={pageSizes().length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-sm text-fg-3">
                <Show
                  when={loading()}
                  fallback={
                    <span>
                      {props.path
                        ? "No PDF yet — click Recompile"
                        : "Compile to render PDF"}
                    </span>
                  }
                >
                  <Loader2 size={14} class="animate-spin" />
                </Show>
              </div>
            }
          >
            <div class="flex flex-col items-center gap-4 py-6">
              <For each={pageSizes()}>
                {(sz, i) => {
                  const pageNum = i() + 1;
                  return (
                    <div
                      data-page={pageNum}
                      class="relative rounded-md bg-white shadow-[0_18px_60px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.25)]"
                      style={{
                        width: `${Math.round(sz.w * scale())}px`,
                        height: `${Math.round(sz.h * scale())}px`,
                      }}
                      onClick={(e) => handlePageClick(e, pageNum)}
                      onDblClick={(e) => triggerInverseSearch(e, pageNum)}
                      title="Double-click to jump to source"
                    >
                      <div class="mono absolute -left-12 top-1.5 select-none text-[10px] text-fg-3">
                        p. {pageNum}
                      </div>
                      <div
                        data-pidx={pageNum}
                        ref={(el) => registerPage(pageNum, el)}
                        class="absolute inset-0 overflow-hidden rounded-md"
                      />
                      <Show when={highlight()?.page === pageNum}>
                        <div
                          class="pointer-events-none absolute left-0 right-0"
                          style={{
                            top: `${highlight()!.yCss - 2}px`,
                            height: "4px",
                            background:
                              "linear-gradient(90deg, var(--color-accent-1), var(--color-accent-2))",
                            "box-shadow":
                              "0 0 12px var(--color-accent-1), 0 0 24px var(--color-accent-2)",
                            animation: "synctex-pulse 1.6s ease-out forwards",
                          }}
                        />
                      </Show>
                    </div>
                  );
                }}
              </For>
              <div class="mono mt-2 text-[10px] text-fg-3">
                — end of preview ({totalPages()} pages) —
              </div>
            </div>
          </Show>
        </div>
      </div>
    </div>
  );
};

/**
 * Square icon-only toggle for the PDF toolbar (Logs/Console, AI). 36px
 * hit target; the icon scales with `--ui-icon-chrome` density (20px Cozy).
 * Hover tooltip carries the label.
 */
const ToolbarIconToggle: Component<{
  active: boolean;
  onClick: () => void;
  icon: any;
  label: string;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    title={props.label}
    aria-label={props.label}
    aria-pressed={props.active}
    class={`lift flex h-9 w-9 items-center justify-center rounded-md ${
      props.active
        ? "text-fg-1"
        : "glass-soft text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
    }`}
    style={
      props.active
        ? {
            background: "color-mix(in srgb, var(--color-accent-1) 18%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-accent-1) 45%, transparent)",
          }
        : undefined
    }
  >
    {props.icon}
  </button>
);

