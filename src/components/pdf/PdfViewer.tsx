import { describeIpcError } from "~/lib/errors";
import { readFile } from "@tauri-apps/plugin-fs";
import {
  AlertTriangle,
  ChevronDown,
  ChevronUp,
  ListTodo,
  Loader2,
  MessageSquare,
  Play,
  Sparkles,
  Square,
  Terminal,
  ZoomIn,
} from "lucide-solid";
import * as pdfjs from "pdfjs-dist";
// Vite-resolves the worker file to a URL and serves it as a separate chunk.
import workerSrc from "pdfjs-dist/build/pdf.worker.mjs?url";
import "~/components/pdf/pdf-text-layer.css";
import type { Component, JSX } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
  onMount,
  untrack,
} from "solid-js";
import { AiView } from "~/components/editor/AiView";
import { ExportMenu } from "~/components/editor/ExportMenu";
import { aiAssistantEnabled } from "~/integrations/ai/actions";
import { chatStreaming } from "~/stores/ai-chat-store";
import { LogsView } from "~/components/editor/LogsDrawer";
import { Switch } from "~/components/forms/Switch";
import { Button } from "~/components/primitives/Button";
import { IconButton } from "~/components/primitives/IconButton";
import { KbdHint } from "~/components/primitives/KbdHint";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { computeFitScale, type ZoomMode } from "~/components/pdf/zoom";
import { locateAnchorRects, type PtRect } from "~/components/pdf/annotation-rects";
import {
  compileEngine,
  editorSettings,
  setEditorSettings,
} from "~/stores/settings-store";
import { isTabletViewport, touchAffordances } from "~/stores/viewport-store";
import { isDarkTheme, theme } from "~/themes/theme-store";
import {
  animations,
  consolePosition,
  previewMode,
  setPreviewMode,
} from "~/stores/ui-store";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

type RenderTask = ReturnType<pdfjs.PDFPageProxy["render"]>;
// Derived rather than deep-imported from pdfjs-dist/types — those paths are
// not part of the package's export map.
type TextContent = Awaited<ReturnType<pdfjs.PDFPageProxy["getTextContent"]>>;
type TextItem = Extract<TextContent["items"][number], { str: string }>;

import type { PdfAnnotation, CreateThreadInput } from "~/lib/pdf-annotations/types";
export type { PdfAnnotation, CreateThreadInput };

interface PdfViewerProps {
  /** Absolute path on disk. Reloaded whenever it changes (or version bumps). */
  path: string | null;
  /** Bump to force a reload while keeping the same path (after a recompile). */
  version?: number;
  /** Triggered when the user clicks the toolbar Recompile button. */
  onCompile?: () => void;
  /** Whether a compile is currently running (drives the button state). */
  compiling?: boolean;
  /** Cancels the in-flight compile — turns the compile button into Stop.
   *  Absent in the detached preview, which keeps the plain busy state. */
  onCancelCompile?: () => void;
  /** Epoch ms of the running compile's start; null when idle. Drives the
   *  elapsed ticker next to the compile button (hidden when absent). */
  compileStartedAt?: number | null;
  /** The PDF on screen predates a failed compile — shows the stale ribbon. */
  stale?: boolean;
  /** Opens the errors surface from the stale ribbon's "View errors". */
  onShowErrors?: () => void;
  /**
   * Inverse-search hook. Fires when the user clicks (or shift-clicks,
   * depending on the parent's policy) on a page. `x` and `y` are in PDF
   * points relative to that page's top-left corner — exactly what
   * `synctex edit` expects.
   */
  onPageClick?: (page: number, x: number, y: number, selectedText?: string) => void;
  /**
   * Forward-search target. When this signal changes, scroll to (page, y).
   * `y` is in PDF points from the top of that page; the viewer converts
   * to CSS pixels using the current zoom scale. A non-null `generation`
   * field guarantees re-firing on identical (page, y) repeats.
   */
  scrollTarget?: { page: number; y: number; generation: number } | null;
  /**
   * Create a review/TODO thread from the current PDF text selection. When
   * absent, the selection chip's Comment/TODO actions are hidden (e.g. a
   * read-only host). The host owns SyncTeX inverse + source anchoring.
   */
  onCreateThread?: (input: CreateThreadInput) => void;
  /** Open the review panel targeted at a thread (highlight click). */
  onOpenThread?: (threadId: string) => void;
  /** Thread highlights to paint over the pages (E10c). */
  annotations?: PdfAnnotation[];
  /**
   * Embedded/detached-window mode: hides the Export menu and the Console/AI
   * toggles (the detached preview window is PDF-only, with no file dialogs or
   * editor-store-backed panes).
   */
  embedded?: boolean;
}

const ZOOM_PRESETS = [50, 75, 100, 125, 150, 200] as const;

/** Ctrl/Cmd+wheel zoom bounds — matches the Settings default-zoom range. */
const WHEEL_ZOOM_MIN = 0.25;
const WHEEL_ZOOM_MAX = 4;

// Mirrors the panel-local ENGINE_LABEL in SettingsScreen's EditorPanel.
const COMPILE_ENGINE_LABEL: Record<string, string> = {
  "system-tex": "System TeX",
  tectonic: "Tectonic",
  "texlive-wasm": "TeX Live (WASM)",
};

/** Pre-render this many CSS px above/below the viewport so a quick scroll
 *  doesn't reveal blank pages before they paint. */
const RENDER_MARGIN_PX = 800;

/** Approx one text line in PDF points — the vertical extent of a thread
 *  highlight band (SyncTeX resolves to a line, not a glyph box) and the
 *  tolerance for click hit-testing it. Fallback only: refined word rects and
 *  the SyncTeX hbox render (and hit-test) at their own geometry. */
const HIGHLIGHT_BAND_PT = 13;

/** Slop in pt around refined rects / the SyncTeX box when hit-testing clicks —
 *  a glyph-tight target would be unclickable. */
const HIT_SLOP_PT = 3;

interface PageSlot {
  /** The canvas host (absolute inset-0 of the page box) the render mounts into. */
  host: HTMLElement;
  task: RenderTask | null;
  canvas: HTMLCanvasElement | null;
  /** Scale the current canvas was rendered at; null when nothing is mounted. */
  renderedScale: number | null;
  /** The text-layer host (absolute inset-0, above the canvas) for selection. */
  textHost: HTMLElement | null;
  /** The live pdfjs TextLayer for this page, or null when none is built. */
  textLayer: pdfjs.TextLayer | null;
  /** loadGen the current text layer belongs to (stale ones get rebuilt). */
  textGen: number;
  /** A build is mid-flight (between the getTextContent await and assignment);
   *  serializes builds so a concurrent call can't create a duplicate layer. */
  textBuilding: boolean;
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
  let rootRef: HTMLDivElement | undefined;
  // Unscaled (scale=1) page dimensions in PDF points; placeholder CSS size is
  // these times the current zoom scale. Drives the layout + scrollbar.
  const [pageSizes, setPageSizes] = createSignal<{ w: number; h: number }[]>([]);
  // Initial zoom seeds from the pdfDefaultZoom setting (percent → factor).
  const initialZoom = editorSettings().pdfDefaultZoom ?? 110;
  const [scale, setScale] = createSignal(initialZoom / 100);
  // The zoom *intent*: a numeric percentage, or a fit mode that recomputes
  // `scale` from the container size. `scale` stays the rendering truth.
  const [zoomMode, setZoomMode] = createSignal<ZoomMode>(initialZoom);
  // Bumped by a ResizeObserver on the scroll container so fit modes re-apply.
  const [containerSize, setContainerSize] = createSignal(0);
  const [zoomOpen, setZoomOpen] = createSignal(false);

  installDismiss(() => zoomRef, zoomOpen, () => setZoomOpen(false));
  useListboxOpenFocus(zoomOpen, () => zoomRef);

  // Compile-options popover (caret next to the compile button): quick access
  // to the two compile-loop settings without a Settings round-trip.
  let compileMenuRef: HTMLDivElement | undefined;
  const [compileMenuOpen, setCompileMenuOpen] = createSignal(false);
  installDismiss(() => compileMenuRef, compileMenuOpen, () => setCompileMenuOpen(false));

  const scrollBehavior = (): ScrollBehavior =>
    !animations() ||
    (typeof window !== "undefined" &&
      window.matchMedia("(prefers-reduced-motion: reduce)").matches)
      ? "auto"
      : "smooth";

  // When the AI master switch flips off while the chat is showing, fall back to
  // the PDF so the pane never strands on a hidden mode. The one shared
  // predicate every AI surface derives from.
  const aiEnabled = aiAssistantEnabled;
  createEffect(() => {
    if (!aiEnabled() && previewMode() === "ai") setPreviewMode("pdf");
  });
  const [loading, setLoading] = createSignal(false);
  const [err, setErr] = createSignal<string | null>(null);

  // Elapsed m:ss while a compile runs. A 250ms cadence keeps the second flips
  // prompt without a per-frame timer; the interval dies with the effect rerun
  // (compile settles → compileStartedAt goes null) or unmount.
  const [elapsed, setElapsed] = createSignal("");
  createEffect(() => {
    const started = props.compileStartedAt;
    if (started == null) return;
    const tick = () => {
      const secs = Math.max(0, Math.floor((Date.now() - started) / 1000));
      setElapsed(`${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, "0")}`);
    };
    tick();
    const id = window.setInterval(tick, 250);
    onCleanup(() => window.clearInterval(id));
  });
  const [currentPage, setCurrentPage] = createSignal(1);
  const [highlight, setHighlight] = createSignal<
    { page: number; yCss: number } | null
  >(null);
  let savedScrollTop = 0;
  // Captured at the moment a zoom starts so the content under the viewport top
  // stays put across the reflow (scrollTop is in CSS px, which the zoom scales).
  let zoomAnchorTop = 0;
  let zoomAnchorLeft = 0;
  let zoomAnchorScale = scale();
  // Cursor point (scroll-container-relative CSS px) of a ctrl/cmd+wheel zoom.
  // The scale effect consumes it once to keep that point stationary instead
  // of anchoring the viewport's top-left like toolbar zooms do.
  let wheelAnchor: { x: number; y: number } | null = null;
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

  // Per-load text-content cache: getTextContent is a worker round-trip, and
  // the highlight refinement pass may consult the same page once per thread.
  // Cleared wherever pageProxies is (load + path clear) — a recompile can
  // change page text without changing the layout.
  const textContentCache = new Map<number, Promise<TextContent | null>>();
  const getTextContent = (n: number): Promise<TextContent | null> => {
    let p = textContentCache.get(n);
    if (!p) {
      p = getPage(n).then((pg) => (pg ? pg.getTextContent() : null));
      textContentCache.set(n, p);
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

  // Build (or, on a pure zoom, cheaply re-layout) the selectable text layer for
  // a visible page. The transparent glyph boxes sit above the canvas so native
  // selection works; the font-size + container size track `--total-scale-factor`
  // (set reactively on the page box), so only the baked per-span `--scale-x`
  // needs the update({viewport}) re-layout on zoom.
  const renderTextLayer = async (pageNum: number) => {
    const slot = slots.get(pageNum);
    if (!slot || !slot.textHost || !docRef) return;
    const gen = loadGen;
    const s = scale();
    const page = await getPage(pageNum);
    if (
      !page ||
      gen !== loadGen ||
      !slots.has(pageNum) ||
      !visible.has(pageNum) ||
      !slot.textHost
    ) {
      return;
    }
    const viewport = page.getViewport({ scale: s });
    if (slot.textLayer && slot.textGen === gen) {
      slot.textLayer.update({ viewport });
      return;
    }
    // `slot.textLayer` isn't assigned until after the getTextContent await, so a
    // second concurrent call (intersection + zoom / recompile fast-path) would
    // slip past the null check above and build a duplicate layer into the same
    // host, leaking the first. Serialize builds per slot — the analogue of
    // renderPage cancelling its in-flight task at entry.
    if (slot.textBuilding) return;
    slot.textBuilding = true;
    try {
      slot.textLayer?.cancel();
      slot.textLayer = null;
      slot.textHost.replaceChildren();
      let textSource;
      try {
        textSource = await page.getTextContent();
      } catch {
        return;
      }
      // The page may have scrolled out (canvas released) during the await —
      // don't build a live text layer over an unrendered page.
      if (
        gen !== loadGen ||
        !slots.has(pageNum) ||
        !visible.has(pageNum) ||
        !slot.textHost
      ) {
        return;
      }
      const tl = new pdfjs.TextLayer({
        textContentSource: textSource,
        container: slot.textHost,
        viewport,
      });
      slot.textLayer = tl;
      slot.textGen = gen;
      try {
        await tl.render();
      } catch {
        return; // cancelled (superseded / torn down)
      }
      if (gen !== loadGen || !slots.has(pageNum) || !visible.has(pageNum)) {
        tl.cancel();
        slot.textHost?.replaceChildren();
        if (slot.textLayer === tl) slot.textLayer = null;
        return;
      }
      // A zoom during the build left the baked per-span --scale-x at the old
      // scale — re-layout to the current one.
      const cur = scale();
      if (cur !== s) tl.update({ viewport: page.getViewport({ scale: cur }) });
    } finally {
      slot.textBuilding = false;
    }
  };

  const clearTextLayer = (slot: PageSlot) => {
    slot.textLayer?.cancel();
    slot.textLayer = null;
    slot.textGen = 0;
    slot.textHost?.replaceChildren();
  };

  const unrenderPage = (pageNum: number) => {
    const slot = slots.get(pageNum);
    if (!slot) return;
    slot.task?.cancel();
    slot.task = null;
    clearTextLayer(slot);
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
      slot.textLayer?.cancel();
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
        void renderTextLayer(pageNum);
      } else {
        visible.delete(pageNum);
        unrenderPage(pageNum);
      }
    }
  };

  // Track the page under the reader's eye during free scrolling so the toolbar
  // indicator follows along (and prev/next anchor off it). State-only: this
  // never scrolls — setPage stays the scrolling setter for the nav buttons and
  // SyncTeX, so it can't fight forward-search or recompile scroll retention.
  //
  // Programmatic smooth scrolls DO fire scroll events, though — without a
  // hold, the tracker regresses the indicator to every page the animation
  // passes through, and a second quick "next" click re-targets a transit page.
  // Holders pass their destination; tracking resumes when the probe reaches it
  // (or after a timeout, in case the flight is interrupted).
  let scrollRaf = 0;
  let heldTarget: number | null = null;
  let holdTimer: number | undefined;
  const holdScrollTracking = (target: number) => {
    heldTarget = target;
    window.clearTimeout(holdTimer);
    holdTimer = window.setTimeout(() => {
      heldTarget = null;
    }, 1000);
  };
  const trackScrollPage = () => {
    if (scrollRaf) return;
    scrollRaf = requestAnimationFrame(() => {
      scrollRaf = 0;
      if (!scrollEl) return;
      // The page ~35% down the viewport reads as "the page you're on" — the
      // top edge flips too early, the midpoint too late on short viewports.
      const y = scrollEl.scrollTop + scrollEl.clientHeight * 0.35;
      const boxes = scrollEl.querySelectorAll<HTMLElement>("[data-page]");
      if (boxes.length === 0) return;
      // Boxes are in document order; take the last one starting at or above
      // the probe line, so a probe inside the gap resolves to the page above.
      let page = Number(boxes[0].dataset.page);
      for (const box of boxes) {
        if (box.offsetTop > y) break;
        page = Number(box.dataset.page);
      }
      // A short trailing page can leave the probe stuck on its predecessor at
      // max scroll — pinned to the bottom means the last page, full stop.
      if (scrollEl.scrollTop + scrollEl.clientHeight >= scrollEl.scrollHeight - 1) {
        page = Number(boxes[boxes.length - 1].dataset.page);
      }
      if (heldTarget !== null) {
        if (page !== heldTarget) return;
        heldTarget = null;
        window.clearTimeout(holdTimer);
      }
      setCurrentPage(page);
    });
  };

  // Ctrl/Cmd+wheel zooms the PDF pane — preventDefault deliberately shadows
  // the webview's global ctrl+scroll zoom inside this pane only; wheel without
  // the modifier stays native scroll. Steps are multiplicative (smooth for
  // both mouse notches and trackpad pinch, which webviews deliver as
  // ctrl+wheel), clamped to 25–400%, anchored to the cursor via wheelAnchor.
  const onWheelZoom = (e: WheelEvent) => {
    if (!e.ctrlKey && !e.metaKey) return;
    e.preventDefault();
    if (!scrollEl || pageSizes().length === 0) return;
    const cur = untrack(scale);
    const next = Math.min(
      WHEEL_ZOOM_MAX,
      Math.max(WHEEL_ZOOM_MIN, cur * Math.exp(-e.deltaY * 0.0015)),
    );
    if (next === cur) return;
    const rect = scrollEl.getBoundingClientRect();
    wheelAnchor = { x: e.clientX - rect.left, y: e.clientY - rect.top };
    // Numeric mode so a wheel zoom detaches from fit-width/fit-page intent.
    setZoomMode(next * 100);
  };

  // Ref on the scroll container. It's the IntersectionObserver root and mounts
  // exactly once (the AI/console panes overlay it rather than unmounting it),
  // so the observer + slots stay stable across preview-mode switches.
  let resizeObs: ResizeObserver | undefined;
  let resizeRaf = 0;
  const setScrollEl = (el: HTMLDivElement) => {
    scrollEl?.removeEventListener("scroll", trackScrollPage);
    scrollEl?.removeEventListener("wheel", onWheelZoom);
    scrollEl = el;
    el.addEventListener("scroll", trackScrollPage, { passive: true });
    // Non-passive on purpose: the handler preventDefault()s modifier-wheel.
    el.addEventListener("wheel", onWheelZoom, { passive: false });
    observer?.disconnect();
    observer = new IntersectionObserver(onIntersect, {
      root: el,
      rootMargin: `${RENDER_MARGIN_PX}px 0px`,
      threshold: 0,
    });
    for (const slot of slots.values()) observer.observe(slot.host);
    // Drive fit-mode recomputation on pane resize (rAF-coalesced so a drag
    // doesn't thrash). Only fit modes read containerSize().
    resizeObs?.disconnect();
    resizeObs = new ResizeObserver(() => {
      if (resizeRaf) return;
      resizeRaf = requestAnimationFrame(() => {
        resizeRaf = 0;
        setContainerSize((n) => n + 1);
      });
    });
    resizeObs.observe(el);
  };

  const registerPage = (pageNum: number, host: HTMLElement) => {
    const slot: PageSlot = {
      host,
      task: null,
      canvas: null,
      renderedScale: null,
      textHost: null,
      textLayer: null,
      textGen: 0,
      textBuilding: false,
    };
    slots.set(pageNum, slot);
    observer?.observe(host);
    // Self-clean when Solid disposes this row (new/smaller doc, path cleared,
    // load error). The guarded delete prevents a stale teardown from evicting
    // a freshly re-registered slot for the same page number.
    onCleanup(() => {
      observer?.unobserve(host);
      slot.task?.cancel();
      slot.textLayer?.cancel();
      if (slot.canvas) {
        slot.canvas.width = 0;
        slot.canvas.height = 0;
      }
      visible.delete(pageNum);
      if (slots.get(pageNum) === slot) slots.delete(pageNum);
    });
  };

  // The text-layer host mounts as a sibling of the canvas host in the same row
  // render, so the slot already exists by the time this ref fires. Building the
  // layer here (when the page is already visible) covers the recompile fast
  // path, where the observer doesn't re-fire for unchanged intersections.
  const setTextHost = (pageNum: number, el: HTMLElement) => {
    const slot = slots.get(pageNum);
    if (!slot) return;
    slot.textHost = el;
    if (visible.has(pageNum)) void renderTextLayer(pageNum);
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
      textContentCache.clear();
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
        for (const slot of slots.values()) {
          slot.renderedScale = null;
          clearTextLayer(slot);
        }
        for (const pageNum of [...visible]) {
          void renderPage(pageNum);
          void renderTextLayer(pageNum);
        }
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
          textContentCache.clear();
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
          const ratio = s / zoomAnchorScale;
          if (wheelAnchor) {
            // Keep the content point under the cursor stationary: the point's
            // content-space offset (scroll + cursor) scales by the ratio, then
            // the cursor's viewport offset is subtracted back out.
            scrollEl.scrollTop = (zoomAnchorTop + wheelAnchor.y) * ratio - wheelAnchor.y;
            scrollEl.scrollLeft = (zoomAnchorLeft + wheelAnchor.x) * ratio - wheelAnchor.x;
            wheelAnchor = null;
          } else {
            scrollEl.scrollTop = zoomAnchorTop * ratio;
          }
        }
        for (const pageNum of [...visible]) {
          void renderPage(pageNum);
          void renderTextLayer(pageNum);
        }
      },
      { defer: true },
    ),
  );

  const applyScale = (s: number) => {
    const cur = untrack(scale);
    if (s === cur) return;
    zoomAnchorTop = scrollEl?.scrollTop ?? 0;
    zoomAnchorLeft = scrollEl?.scrollLeft ?? 0;
    zoomAnchorScale = cur;
    setScale(s);
  };
  const selectZoom = (mode: ZoomMode) => {
    setZoomMode(mode);
    setZoomOpen(false);
  };
  // Resolve zoomMode → scale. Numeric applies directly; fit modes compute from
  // the container + current page and re-apply on container resize / doc reload.
  // currentPage is read untracked so scrolling across differently-sized pages
  // doesn't re-fit (which would jitter).
  createEffect(() => {
    const mode = zoomMode();
    if (typeof mode === "number") {
      applyScale(mode / 100);
      return;
    }
    containerSize();
    const sizes = pageSizes();
    if (!scrollEl || sizes.length === 0) return;
    const page = sizes[untrack(currentPage) - 1] ?? sizes[0];
    applyScale(computeFitScale(scrollEl, page, mode));
  });

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
        holdScrollTracking(t.page);
        setHighlight({ page: t.page, yCss });
        window.setTimeout(() => setHighlight((h) =>
          h && h.page === t.page && h.yCss === yCss ? null : h,
        ), 1600);
      },
      { defer: true },
    ),
  );

  // Glyph-level refinement of the thread highlights: match each annotation's
  // anchor text against the page's text items and keep per-line word rects,
  // keyed by threadId. While a load is in flight the pass would read the
  // OUTGOING document's text — skip and let the loading() settle re-run it;
  // the loadGen capture (mirroring renderTextLayer) drops a pass a newer load
  // superseded mid-flight, so stale rects can never publish over a new PDF.
  const [refinedRects, setRefinedRects] = createSignal<Map<string, PtRect[]>>(
    new Map(),
  );
  createEffect(() => {
    const anns = props.annotations ?? [];
    const sizes = pageSizes();
    if (anns.length === 0 || sizes.length === 0) {
      setRefinedRects(new Map());
      return;
    }
    if (loading()) return;
    const gen = loadGen;
    void (async () => {
      const next = new Map<string, PtRect[]>();
      for (const a of anns) {
        const size = sizes[a.page - 1];
        if (!size) continue;
        const content = await getTextContent(a.page);
        if (gen !== loadGen) return;
        if (!content) continue;
        const items = content.items.filter((it): it is TextItem => "str" in it);
        const rects = locateAnchorRects(items, size.h, a);
        if (rects) next.set(a.threadId, rects);
      }
      if (gen !== loadGen) return;
      setRefinedRects(next);
    })();
  });

  // Inverse search fires on double-click (double-tap on touch) — the
  // natural "take me to this" gesture — with shift+click kept as the
  // power-user shortcut. Plain single clicks stay free for text
  // selection / pan affordances.
  const triggerInverseSearch = (
    e: MouseEvent,
    pageNum: number,
    selectedText?: string,
  ) => {
    if (!props.onPageClick) return;
    // currentTarget is the page box, sized exactly to the page in CSS px.
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const xPx = e.clientX - rect.left;
    const yPx = e.clientY - rect.top;
    if (xPx < 0 || yPx < 0 || xPx > rect.width || yPx > rect.height) return;
    const s = scale();
    e.preventDefault();
    props.onPageClick(pageNum, xPx / s, yPx / s, selectedText);
  };

  // Opening a thread on a highlight click is deferred briefly so a double-click
  // (inverse search) on the same band cancels it instead of both firing — the
  // first `click` of a double-click arrives with the selection still collapsed.
  let openThreadTimer: number | undefined;
  const handlePageClick = (e: MouseEvent, pageNum: number) => {
    if (e.shiftKey) {
      triggerInverseSearch(e, pageNum);
      return;
    }
    // A plain click on a thread highlight opens its panel entry. Hit-test the
    // annotation bands here (rather than making the overlay clickable) so the
    // text layer stays on top for selection without stealing highlight clicks —
    // the click still bubbles to this page box even when it lands on a glyph.
    const onOpen = props.onOpenThread;
    const anns = props.annotations;
    if (!onOpen || !anns || anns.length === 0) return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed) return; // mid-selection, not a thread click
    const rect = (e.currentTarget as HTMLElement).getBoundingClientRect();
    const s = scale();
    const xPt = (e.clientX - rect.left) / s;
    const yPt = (e.clientY - rect.top) / s;
    // Same tier order as the render: refined rects, then the SyncTeX box (both
    // x AND y), and the y-only band test ONLY for band-fallback annotations —
    // a full-width hit zone on a refined highlight would swallow clicks the
    // narrow visual no longer claims.
    const refined = refinedRects();
    const inRect = (r: PtRect) =>
      xPt >= r.left - HIT_SLOP_PT &&
      xPt <= r.left + r.width + HIT_SLOP_PT &&
      yPt >= r.top - HIT_SLOP_PT &&
      yPt <= r.top + r.height + HIT_SLOP_PT;
    const hit = anns.find((a) => {
      if (a.page !== pageNum) return false;
      const rs = refined.get(a.threadId);
      if (rs) return rs.some(inRect);
      if (a.box) return inRect(a.box);
      return yPt >= a.y - HIGHLIGHT_BAND_PT && yPt <= a.y + 3;
    });
    if (hit) {
      e.preventDefault();
      const id = hit.threadId;
      if (openThreadTimer) window.clearTimeout(openThreadTimer);
      openThreadTimer = window.setTimeout(() => {
        openThreadTimer = undefined;
        onOpen(id);
      }, 250);
    }
  };

  // ----- Selection chip: create a review/TODO thread from a PDF selection ----
  interface SelChip {
    left: number; // clamped, root-relative px
    top: number; // root-relative px (top of the selection)
    page: number;
    xPt: number; // selection start, PDF points, page-relative
    yPt: number;
    text: string;
  }
  const [selChip, setSelChip] = createSignal<SelChip | null>(null);
  const [chipMode, setChipMode] = createSignal<"menu" | "comment" | "todo">("menu");
  const [chipBody, setChipBody] = createSignal("");
  let chipTextarea: HTMLTextAreaElement | undefined;

  const clearChip = () => {
    setSelChip(null);
    setChipMode("menu");
    setChipBody("");
  };

  const onSelectionChange = () => {
    // While composing, keep the snapshot — focusing the textarea collapses the
    // PDF selection, which would otherwise clear the chip out from under us.
    if (chipMode() !== "menu") return;
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed || sel.rangeCount === 0 || !rootRef || !scrollEl) {
      setSelChip(null);
      return;
    }
    const range = sel.getRangeAt(0);
    const text = sel.toString().trim();
    if (!text || !scrollEl.contains(range.commonAncestorContainer)) {
      setSelChip(null);
      return;
    }
    const startEl =
      range.startContainer.nodeType === Node.TEXT_NODE
        ? range.startContainer.parentElement
        : (range.startContainer as HTMLElement | null);
    const pageBox = startEl?.closest<HTMLElement>("[data-page]");
    if (!pageBox) {
      setSelChip(null);
      return;
    }
    const pageRect = pageBox.getBoundingClientRect();
    const rangeRect = range.getBoundingClientRect();
    const rootRect = rootRef.getBoundingClientRect();
    const s = scale();
    setSelChip({
      left: Math.min(Math.max(8, rangeRect.left - rootRect.left), Math.max(8, rootRect.width - 268)),
      top: rangeRect.top - rootRect.top,
      page: Number(pageBox.dataset.page),
      xPt: (rangeRect.left - pageRect.left) / s,
      yPt: (rangeRect.top - pageRect.top) / s,
      text,
    });
  };
  document.addEventListener("selectionchange", onSelectionChange);
  onCleanup(() => document.removeEventListener("selectionchange", onSelectionChange));

  const chipCompose = (kind: "comment" | "todo") => {
    setChipMode(kind);
    queueMicrotask(() => chipTextarea?.focus());
  };
  const chipSubmit = () => {
    const c = selChip();
    const mode = chipMode();
    const onCreate = props.onCreateThread;
    if (!c || mode === "menu" || !onCreate) return;
    onCreate({
      kind: mode,
      page: c.page,
      x: c.xPt,
      y: c.yPt,
      selectedText: c.text,
      body: chipBody().trim(),
    });
    clearChip();
    window.getSelection()?.removeAllRanges();
  };
  onCleanup(() => {
    observer?.disconnect();
    resizeObs?.disconnect();
    if (resizeRaf) cancelAnimationFrame(resizeRaf);
    if (scrollRaf) cancelAnimationFrame(scrollRaf);
    window.clearTimeout(holdTimer);
    scrollEl?.removeEventListener("scroll", trackScrollPage);
    scrollEl?.removeEventListener("wheel", onWheelZoom);
    if (openThreadTimer) window.clearTimeout(openThreadTimer);
    for (const slot of slots.values()) {
      slot.task?.cancel();
      slot.textLayer?.cancel();
    }
    taskRef?.destroy();
  });

  const totalPages = () => pageSizes().length;

  const setPage = (n: number) => {
    if (!scrollEl) return;
    const clamped = Math.max(1, Math.min(totalPages(), n));
    setCurrentPage(clamped);
    holdScrollTracking(clamped);
    const el = scrollEl.querySelector<HTMLElement>(`[data-page="${clamped}"]`);
    if (el) el.scrollIntoView({ behavior: scrollBehavior(), block: "start" });
  };

  // Commit the page-nav input: a number goes through setPage (which clamps
  // and holds the scroll tracker); anything else reverts. The value is
  // re-stamped either way so a no-op or clamped commit still shows the
  // canonical page. Same-page commits skip setPage — it scrolls the page top
  // into view, which would yank a mid-page reading position.
  const commitPageInput = (el: HTMLInputElement) => {
    const n = Number.parseInt(el.value.trim(), 10);
    if (Number.isFinite(n) && n !== untrack(currentPage)) setPage(n);
    el.value = String(untrack(currentPage));
  };

  const fileName = () =>
    props.path ? props.path.split(/[\\/]/).pop() ?? "" : "";

  // One Button morphs between Compile/Recompile and Stop: a <Show> swap would
  // unmount the node the keyboard user just activated, dropping focus to
  // <body> on every compile start/settle.
  const stoppable = () => Boolean(props.compiling && props.onCancelCompile);

  return (
    <div ref={rootRef} class="relative flex h-full min-w-0 flex-col overflow-hidden">
      {/* Toolbar — 44px (56px on coarse pointers, where the controls bump to
          44px effective targets). Layout per /design/screens-editor.md
          (updated 2026-05-15):
            [Recompile] [Export icon] [Logs/Console icon] [AI icon]   …   [page nav] [zoom]
          Icon-only toggles carry their labels as IconButton tooltips; the
          Logs/Console icon only renders when console position is "in PDF
          panel". The Recompile button keeps its label because it's the
          primary action. */}
      <div
        class="@container flex flex-shrink-0 items-center gap-1 border-b border-glass-stroke px-2.5"
        classList={{
          "h-14": touchAffordances(),
          "h-[44px]": !touchAffordances(),
        }}
      >
        <Button
          variant={stoppable() ? "danger" : "primary"}
          size="compact"
          onClick={() =>
            stoppable() ? props.onCancelCompile?.() : props.onCompile?.()
          }
          loading={props.compiling && !props.onCancelCompile}
          leadingIcon={
            stoppable() ? (
              <Square size={12} stroke-width={2.2} />
            ) : (
              <Play size={12} stroke-width={2.2} />
            )
          }
          class={`relative gap-2 rounded-lg pl-3 pr-2.5 font-semibold ${
            stoppable() ? "" : "glow-accent disabled:opacity-60"
          }`}
        >
          <span>
            {stoppable()
              ? "Stop"
              : props.compiling
                ? "Compiling…"
                : totalPages() > 0
                  ? "Recompile"
                  : "Compile"}
          </span>
          {/* KbdHint hides itself on tablet; the Show keeps the empty ml-1
              wrapper from leaving phantom trailing space in the button. */}
          <Show when={!stoppable() && !isTabletViewport()}>
            <span class="ml-1 hidden @[28rem]:inline-flex">
              <KbdHint shortcut="Mod+Enter" size="md" tone="dark" />
            </span>
          </Show>
        </Button>
        <Show when={props.compileStartedAt != null}>
          {/* aria-hidden: the sr-only compile live region already announces
              state; a ticking clock would just be noise. */}
          <span aria-hidden="true" class="mono ml-1 text-xs tabular-nums text-fg-3">
            {elapsed()}
          </span>
        </Show>

        <Show when={!props.embedded}>
          <div class="relative" ref={compileMenuRef}>
            <IconButton
              label="Compile options"
              size="md"
              touchTarget
              onClick={() => setCompileMenuOpen((v) => !v)}
              aria-expanded={compileMenuOpen()}
            >
              <ChevronDown size={12} class="opacity-70" />
            </IconButton>
            <Show when={compileMenuOpen()}>
              <div
                class="glass absolute left-0 z-40 mt-1 w-[248px] rounded-lg p-2.5"
                style={{ background: "var(--color-popover-bg)" }}
              >
                <div class="flex flex-col gap-2.5">
                  <Switch
                    label="Compile on save"
                    checked={editorSettings().autoCompile}
                    onChange={(v) =>
                      setEditorSettings({ ...editorSettings(), autoCompile: v })
                    }
                  />
                  <Switch
                    label="Stop on first error"
                    checked={editorSettings().stopOnFirstError}
                    onChange={(v) =>
                      setEditorSettings({ ...editorSettings(), stopOnFirstError: v })
                    }
                  />
                  <div class="border-t border-glass-stroke pt-2 text-xs text-fg-3">
                    Engine:{" "}
                    <span class="text-fg-2">
                      {COMPILE_ENGINE_LABEL[compileEngine()] ?? compileEngine()}
                    </span>
                  </div>
                </div>
              </div>
            </Show>
          </div>
        </Show>

        <Show when={!props.embedded}>
          <ExportMenu pdfPath={props.path} />
        </Show>

        <Show when={consolePosition() === "pdf-tab" && !props.embedded}>
          <ToolbarIconToggle
            active={previewMode() === "console"}
            onClick={() =>
              setPreviewMode(previewMode() === "console" ? "pdf" : "console")
            }
            icon={<Terminal size={16} />}
            label="Logs"
          />
        </Show>

        <Show when={aiEnabled() && !props.embedded}>
          <ToolbarIconToggle
            active={previewMode() === "ai"}
            onClick={() => setPreviewMode(previewMode() === "ai" ? "pdf" : "ai")}
            icon={<Sparkles size={16} />}
            label="AI"
            activityDot={chatStreaming()}
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
              <IconButton
                label="Previous page"
                size="sm"
                touchTarget
                onClick={() => setPage(currentPage() - 1)}
                disabled={totalPages() === 0 || currentPage() <= 1}
                style={{ color: "var(--color-fg-1)" }}
              >
                <ChevronUp size={12} class="opacity-70" />
              </IconButton>
              <div
                class="mono flex items-center gap-1 text-xs"
                classList={{
                  "px-3": touchAffordances(),
                  "px-2": !touchAffordances(),
                }}
              >
                <Show
                  when={totalPages() > 0}
                  fallback={<span class="font-medium text-fg-1">—</span>}
                >
                  <input
                    type="text"
                    inputmode="numeric"
                    aria-label="Current page"
                    value={currentPage()}
                    onFocus={(e) => e.currentTarget.select()}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.currentTarget.blur(); // blur commits
                      } else if (e.key === "Escape") {
                        e.stopPropagation();
                        e.currentTarget.value = String(currentPage());
                        e.currentTarget.blur();
                      }
                    }}
                    onBlur={(e) => commitPageInput(e.currentTarget)}
                    class="mono bg-transparent text-center font-medium text-fg-1 outline-none"
                    classList={{ "py-2.5": touchAffordances() }}
                    style={{
                      width: `${Math.max(2, String(totalPages()).length)}ch`,
                    }}
                  />
                </Show>
                <span class="text-fg-4">/</span>
                <span class="text-fg-2">{totalPages() === 0 ? "—" : totalPages()}</span>
              </div>
              <IconButton
                label="Next page"
                size="sm"
                touchTarget
                onClick={() => setPage(currentPage() + 1)}
                disabled={totalPages() === 0 || currentPage() >= totalPages()}
                style={{ color: "var(--color-fg-1)" }}
              >
                <ChevronDown size={12} class="opacity-70" />
              </IconButton>
            </div>

            {/* Zoom dropdown — rightmost element per updated layout */}
            <div class="relative" ref={zoomRef}>
              <button
                type="button"
                onClick={() => setZoomOpen((v) => !v)}
                aria-haspopup="listbox"
                aria-expanded={zoomOpen()}
                aria-label="Zoom"
                class="lift glass-soft flex items-center gap-1.5 rounded-md px-2.5 text-sm"
                classList={{
                  "h-11": touchAffordances(),
                  "h-8": !touchAffordances(),
                }}
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
                  class="glass absolute right-0 z-40 mt-1 w-[140px] overflow-hidden rounded-lg py-1"
                  style={{ background: "var(--color-popover-bg)" }}
                >
                  <For
                    each={
                      [
                        { mode: "fit-width" as ZoomMode, label: "Fit width" },
                        { mode: "fit-page" as ZoomMode, label: "Fit page" },
                      ]
                    }
                  >
                    {(opt) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={zoomMode() === opt.mode}
                        tabindex={-1}
                        onClick={() => selectZoom(opt.mode)}
                        class={`flex h-7 w-full items-center px-3 text-left text-sm hover:bg-[var(--color-control-fill)] ${
                          zoomMode() === opt.mode ? "text-fg-1 font-medium" : "text-fg-2"
                        }`}
                      >
                        {opt.label}
                      </button>
                    )}
                  </For>
                  <div class="my-1 border-t border-glass-stroke" />
                  <For each={ZOOM_PRESETS}>
                    {(z) => (
                      <button
                        type="button"
                        role="option"
                        aria-selected={zoomMode() === z}
                        tabindex={-1}
                        onClick={() => selectZoom(z)}
                        class={`flex h-7 w-full items-center px-3 text-left text-sm hover:bg-[var(--color-control-fill)] ${
                          zoomMode() === z ? "text-fg-1 font-medium" : "text-fg-2"
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

      {/* Stale-preview ribbon — in normal flow between toolbar and pages so
          it can't cover chrome or intercept scroll. */}
      <Show when={props.stale && previewMode() === "pdf"}>
        <StaleRibbon onShowErrors={props.onShowErrors} />
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
            // Dark-mode PDF reading: invert + hue-rotate keeps color figures
            // roughly true while flipping the white page to dark.
            filter:
              editorSettings().pdfInvertDark && isDarkTheme(theme())
                ? "invert(0.92) hue-rotate(180deg)"
                : undefined,
          }}
        >
          <Show
            when={pageSizes().length > 0}
            fallback={
              <div class="flex h-full items-center justify-center text-sm text-fg-3">
                <Show
                  when={loading()}
                  fallback={
                    <Show
                      when={props.onCompile}
                      fallback={
                        <span>
                          {props.path
                            ? "No PDF yet — click Recompile"
                            : "Compile to render PDF"}
                        </span>
                      }
                    >
                      <Button
                        variant="primary"
                        size="compact"
                        onClick={() => props.onCompile?.()}
                        loading={props.compiling}
                        leadingIcon={<Play size={12} stroke-width={2.2} />}
                        class="glow-accent rounded-lg font-semibold"
                      >
                        Compile to render PDF
                      </Button>
                    </Show>
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
                        // Drives the text layer's glyph font-size + container
                        // size (pdfjs reads --total-scale-factor); the round-step
                        // vars keep its round() width expressions valid.
                        "--total-scale-factor": `${scale()}`,
                        "--scale-round-x": "1px",
                        "--scale-round-y": "1px",
                      }}
                      onClick={(e) => handlePageClick(e, pageNum)}
                      onDblClick={(e) => {
                        // This gesture is a double-click (inverse search) — cancel
                        // any highlight-open its first click may have armed.
                        if (openThreadTimer) {
                          window.clearTimeout(openThreadTimer);
                          openThreadTimer = undefined;
                        }
                        // A double-click always jumps to source; when it landed
                        // on a word, mirror that word's selection in the editor.
                        const selText =
                          window.getSelection()?.toString().trim() || undefined;
                        triggerInverseSearch(e, pageNum, selText);
                      }}
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
                      {/* Thread highlights — per open review/TODO thread
                          SyncTeX-resolved to this page. Three tiers: refined
                          per-line word rects when the anchor text matched the
                          page's text items; else the SyncTeX hbox; else the
                          full-width line band. Painted under the text layer
                          (z:1 < z:2), pointer-events none; clicks are
                          hit-tested on the page box (handlePageClick) so the
                          text layer keeps selection. */}
                      <For each={props.annotations?.filter((a) => a.page === pageNum) ?? []}>
                        {(a) => {
                          const isTodo = a.kind === "todo";
                          const tint = isTodo ? "var(--color-warn)" : "var(--color-accent-1)";
                          return (
                            <Show
                              when={refinedRects().get(a.threadId)}
                              fallback={
                                <Show
                                  when={a.box}
                                  fallback={
                                    <div
                                      class="pointer-events-none absolute left-0 right-0 rounded-[2px]"
                                      style={{
                                        top: `${(a.y - HIGHLIGHT_BAND_PT + 2) * scale()}px`,
                                        height: `${HIGHLIGHT_BAND_PT * 1.15 * scale()}px`,
                                        "z-index": 1,
                                        background: `color-mix(in srgb, ${tint} 20%, transparent)`,
                                        "border-left": `2px solid ${tint}`,
                                      }}
                                    />
                                  }
                                >
                                  {(box) => (
                                    <div
                                      class="pointer-events-none absolute rounded-[2px]"
                                      style={{
                                        left: `${(box().left - 1) * scale()}px`,
                                        top: `${(box().top - 1) * scale()}px`,
                                        width: `${(box().width + 2) * scale()}px`,
                                        height: `${(box().height + 2) * scale()}px`,
                                        "z-index": 1,
                                        background: `color-mix(in srgb, ${tint} 20%, transparent)`,
                                        "border-left": `2px solid ${tint}`,
                                      }}
                                    />
                                  )}
                                </Show>
                              }
                            >
                              {(rects) => (
                                <For each={rects()}>
                                  {(r) => (
                                    <div
                                      class="pointer-events-none absolute rounded-[2px]"
                                      style={{
                                        left: `${(r.left - 1) * scale()}px`,
                                        top: `${(r.top - 1) * scale()}px`,
                                        width: `${(r.width + 2) * scale()}px`,
                                        height: `${(r.height + 2) * scale()}px`,
                                        "z-index": 1,
                                        background: `color-mix(in srgb, ${tint} 30%, transparent)`,
                                      }}
                                    />
                                  )}
                                </For>
                              )}
                            </Show>
                          );
                        }}
                      </For>
                      <div
                        ref={(el) => setTextHost(pageNum, el)}
                        class="pdf-text-layer"
                      />
                      <Show when={highlight()?.page === pageNum}>
                        <div
                          class="pointer-events-none absolute left-0 right-0"
                          style={{
                            top: `${highlight()!.yCss - 2}px`,
                            height: "4px",
                            "z-index": 4,
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

      {/* Selection chip — floats above a PDF text selection with Comment / TODO.
          Rendered at the viewer root (NOT inside the scroll
          container, which may carry the dark-invert `filter` that would both
          re-tint the chip and break its positioning). */}
      <Show when={selChip() && props.onCreateThread}>
        <div
          class="glass absolute z-50 rounded-lg shadow-lg"
          style={{
            left: `${selChip()!.left}px`,
            top: `${selChip()!.top}px`,
            transform: "translateY(calc(-100% - 8px))",
            background: "var(--color-popover-bg)",
          }}
          onKeyDown={(e) => {
            if (e.key === "Escape") {
              e.stopPropagation();
              clearChip();
            }
          }}
        >
          <Show
            when={chipMode() === "menu"}
            fallback={
              <div class="flex w-[248px] flex-col gap-1.5 p-2">
                <div class="label-xs px-0.5 text-fg-3">
                  {chipMode() === "todo" ? "New TODO" : "New comment"}
                </div>
                <textarea
                  ref={chipTextarea}
                  value={chipBody()}
                  onInput={(e) => setChipBody(e.currentTarget.value)}
                  onKeyDown={(e) => {
                    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                      e.preventDefault();
                      chipSubmit();
                    }
                  }}
                  rows={3}
                  placeholder="Add a note…"
                  class="w-full resize-none rounded-md bg-[var(--color-control-fill)] p-2 text-sm text-fg-1 outline-none placeholder:text-fg-3"
                />
                <div class="flex items-center justify-end gap-1.5">
                  <button
                    type="button"
                    onClick={clearChip}
                    class="rounded-md px-2 py-1 text-xs text-fg-3 hover:text-fg-1"
                  >
                    Cancel
                  </button>
                  <button
                    type="button"
                    onClick={chipSubmit}
                    class="lift rounded-md accent-grad px-2.5 py-1 text-xs font-semibold"
                  >
                    {chipMode() === "todo" ? "Add TODO" : "Add comment"}
                  </button>
                </div>
              </div>
            }
          >
            {/* preventDefault keeps the click from collapsing the PDF selection
                before the action handler snapshots it. */}
            <div class="flex items-center gap-0.5 p-1" onMouseDown={(e) => e.preventDefault()}>
              <Show when={props.onCreateThread}>
                <ChipAction
                  icon={<MessageSquare size={13} />}
                  label="Comment"
                  onClick={() => chipCompose("comment")}
                />
                <ChipAction
                  icon={<ListTodo size={13} />}
                  label="TODO"
                  onClick={() => chipCompose("todo")}
                />
              </Show>
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

/**
 * Slim warn-tinted banner pinned above the page scroll area while the PDF on
 * screen predates a failed compile. Fades in over 200ms via a mount-flipped
 * opacity transition; the global motion kill-switch (motion.css) zeroes the
 * duration under reduced motion, so no per-surface guard is needed.
 */
const StaleRibbon: Component<{ onShowErrors?: () => void }> = (props) => {
  const [shown, setShown] = createSignal(false);
  onMount(() => requestAnimationFrame(() => setShown(true)));
  return (
    <div
      class={`flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-3 py-1.5 text-xs text-fg-1 transition-opacity duration-200 ${
        shown() ? "opacity-100" : "opacity-0"
      }`}
      style={{
        background: "color-mix(in srgb, var(--color-warn) 12%, transparent)",
      }}
    >
      <AlertTriangle
        size={12}
        class="flex-shrink-0"
        style={{ color: "var(--color-warn)" }}
      />
      <span class="min-w-0 flex-1 truncate">
        Preview is stale — showing the last successful compile
      </span>
      <Show when={props.onShowErrors}>
        <button
          type="button"
          onClick={() => props.onShowErrors?.()}
          class="flex-shrink-0 font-medium underline-offset-2 hover:underline"
          style={{ color: "var(--color-warn)" }}
        >
          View errors
        </button>
      </Show>
    </div>
  );
};

const ChipAction: Component<{
  icon: JSX.Element;
  label: string;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    class="lift flex h-7 items-center gap-1.5 rounded-md px-2 text-xs font-medium text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
  >
    {props.icon}
    <span>{props.label}</span>
  </button>
);

/**
 * Square icon-only toggle for the PDF toolbar (Logs/Console, AI). 36px
 * hit target (44px on coarse pointers via touchTarget); the icon scales with
 * `--ui-icon-chrome` density (20px Cozy).
 * The IconButton tooltip carries the label. Colors ride inline style: the
 * active/inactive fg must beat the ghost variant's text utilities, and the
 * active accent wash must beat glass-soft.
 */
const ToolbarIconToggle: Component<{
  active: boolean;
  onClick: () => void;
  icon: any;
  label: string;
  /** Subtle corner dot — e.g. an AI stream running behind another pane. */
  activityDot?: boolean;
}> = (props) => (
  <IconButton
    label={props.label}
    size="lg"
    touchTarget
    onClick={props.onClick}
    aria-pressed={props.active}
    class={`relative ${
      props.active ? "" : "glass-soft enabled:hover:bg-[var(--color-control-fill-hover)]"
    }`}
    style={
      props.active
        ? {
            color: "var(--color-fg-1)",
            background: "color-mix(in srgb, var(--color-accent-1) 18%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-accent-1) 45%, transparent)",
          }
        : { color: "var(--color-fg-2)" }
    }
  >
    {props.icon}
    <Show when={props.activityDot}>
      <span
        class="absolute right-1 top-1 h-1.5 w-1.5 animate-pulse rounded-full"
        style={{ background: "var(--color-accent-1)" }}
      />
    </Show>
  </IconButton>
);

