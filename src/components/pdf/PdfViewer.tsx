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
import { For, Match, Show, Switch, createEffect, createSignal, on, onCleanup } from "solid-js";
import { AiView } from "~/components/editor/AiView";
import { ExportMenu } from "~/components/editor/ExportMenu";
import { LogsView } from "~/components/editor/LogsDrawer";
import { installDismiss } from "~/lib/dismiss";
import { integrationsSettings } from "~/stores/settings-store";
import {
  animations,
  consolePosition,
  previewMode,
  setPreviewMode,
} from "~/stores/ui-store";

pdfjs.GlobalWorkerOptions.workerSrc = workerSrc;

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

/**
 * Toolbar ported from `design_files/Editor.html` PdfPreview (line 7741+):
 *   - Recompile (hero, accent-grad, ⌘↵ kbd)
 *   - Page nav with current/total
 *   - Zoom dropdown
 *   - Download
 *
 * Pages are rendered continuously, stacked vertically. Scroll position and
 * zoom are retained across recompiles.
 */
export const PdfViewer: Component<PdfViewerProps> = (props) => {
  let scrollEl!: HTMLDivElement;
  let zoomRef: HTMLDivElement | undefined;
  const [pages, setPages] = createSignal<HTMLCanvasElement[]>([]);
  const [scale, setScale] = createSignal(1.1);
  const [zoomOpen, setZoomOpen] = createSignal(false);

  installDismiss(() => zoomRef, zoomOpen, () => setZoomOpen(false));

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
  let docRef: pdfjs.PDFDocumentProxy | null = null;
  // Bumps on every load() / re-render request. Older async chains compare
  // this to their captured `gen` after each await and exit if superseded —
  // without this, a slow load completing after a newer one wipes the screen.
  let loadGen = 0;

  const isCancellation = (e: unknown): boolean =>
    !!e &&
    typeof e === "object" &&
    (e as { name?: string }).name === "RenderingCancelledException";

  const load = async (path: string) => {
    const gen = ++loadGen;
    setLoading(true);
    setErr(null);
    try {
      const bytes = await readFile(path);
      if (gen !== loadGen) return;
      const buf = new Uint8Array(bytes.byteLength);
      buf.set(bytes);
      const doc = await pdfjs.getDocument({ data: buf }).promise;
      if (gen !== loadGen) {
        doc.destroy();
        return;
      }
      if (docRef) docRef.destroy();
      docRef = doc;
      await renderAll(doc, scale(), gen);
    } catch (e) {
      if (gen !== loadGen) return;
      // PDF.js throws this when an in-flight render is replaced by a newer
      // one — expected behavior during quick recompile sequences, not an
      // actual failure. Silently swallow.
      if (isCancellation(e)) return;
      setErr(String(e));
      setPages([]);
    } finally {
      if (gen === loadGen) setLoading(false);
    }
  };

  const renderAll = async (
    doc: pdfjs.PDFDocumentProxy,
    s: number,
    gen: number = loadGen,
  ) => {
    const canvases: HTMLCanvasElement[] = [];
    for (let i = 1; i <= doc.numPages; i++) {
      if (gen !== loadGen) return;
      const page = await doc.getPage(i);
      if (gen !== loadGen) return;
      const viewport = page.getViewport({ scale: s });
      const canvas = document.createElement("canvas");
      const dpr = window.devicePixelRatio || 1;
      canvas.width = Math.floor(viewport.width * dpr);
      canvas.height = Math.floor(viewport.height * dpr);
      canvas.style.width = `${Math.floor(viewport.width)}px`;
      canvas.style.height = `${Math.floor(viewport.height)}px`;
      const ctx = canvas.getContext("2d");
      if (ctx) {
        ctx.scale(dpr, dpr);
        try {
          await page.render({
            canvasContext: ctx,
            viewport,
            canvas,
          } as unknown as Parameters<typeof page.render>[0]).promise;
        } catch (e) {
          if (isCancellation(e)) return;
          throw e;
        }
      }
      canvases.push(canvas);
    }
    if (gen !== loadGen) return;
    setPages(canvases);
    requestAnimationFrame(() => {
      if (scrollEl) scrollEl.scrollTop = savedScrollTop;
    });
  };

  // Initial + path changes: reload the doc.
  createEffect(
    on(
      () => [props.path, props.version ?? 0] as const,
      ([path]) => {
        savedScrollTop = scrollEl?.scrollTop ?? 0;
        if (!path) {
          setPages([]);
          return;
        }
        void load(path);
      },
    ),
  );

  // Zoom changes: re-render at new scale (no fresh load). Bumps the
  // generation so two quick zoom changes can't race — without it the
  // slower render could land last and win over the newer scale.
  createEffect(
    on(
      scale,
      async (s) => {
        if (!docRef) return;
        savedScrollTop = scrollEl?.scrollTop ?? 0;
        await renderAll(docRef, s, ++loadGen);
      },
      { defer: true },
    ),
  );

  // Forward-search: scroll to (page, y) and pulse a highlight ribbon.
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
    const wrapper = e.currentTarget as HTMLElement;
    const canvas = wrapper.querySelector("canvas");
    if (!canvas) return;
    const rect = canvas.getBoundingClientRect();
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
    docRef?.destroy();
  });

  const totalPages = () => pages().length;

  const setPage = (n: number) => {
    const pageEls = scrollEl?.querySelectorAll("[data-page]");
    if (!pageEls) return;
    const clamped = Math.max(1, Math.min(totalPages(), n));
    setCurrentPage(clamped);
    const el = pageEls[clamped - 1] as HTMLElement | undefined;
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
      <div class="flex h-[44px] flex-shrink-0 items-center gap-1 border-b border-glass-stroke px-2.5">
        <button
          type="button"
          onClick={() => props.onCompile?.()}
          disabled={props.compiling}
          class="lift glow-accent relative flex h-8 items-center gap-2 rounded-lg accent-grad pl-3 pr-2.5 text-[12px] font-semibold disabled:cursor-not-allowed disabled:opacity-60"
        >
          <Show
            when={props.compiling}
            fallback={<Play size={12} stroke-width={2.2} />}
          >
            <Loader2 size={12} class="animate-spin" />
          </Show>
          <span>{props.compiling ? "Compiling…" : "Recompile"}</span>
          <span class="ml-1">
            <ToolbarKbd shortcut="Mod+Enter" />
          </span>
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
          <span class="mono ml-2 truncate text-[11px] text-fg-3">
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
              >
                <ChevronUp size={12} class="opacity-70" />
              </button>
              <div class="mono flex items-center gap-1 px-2 text-[11px]">
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
              >
                <ChevronDown size={12} class="opacity-70" />
              </button>
            </div>

            {/* Zoom dropdown — rightmost element per updated layout */}
            <div class="relative" ref={zoomRef}>
              <button
                type="button"
                onClick={() => setZoomOpen((v) => !v)}
                class="lift glass-soft flex h-8 items-center gap-1.5 rounded-md px-2.5 text-[12px]"
              >
                <ZoomIn size={12} class="opacity-70" />
                <span class="mono min-w-[58px] text-left text-fg-1">
                  {Math.round(scale() * 100)}%
                </span>
                <ChevronDown size={10} class="opacity-50" />
              </button>
              <Show when={zoomOpen()}>
                <>
                  <div
                    class="fixed inset-0 z-30"
                    onClick={() => setZoomOpen(false)}
                  />
                  <div
                    class="glass absolute right-0 z-40 mt-1 w-[140px] overflow-hidden rounded-md py-1"
                    style={{ background: "var(--color-popover-bg)" }}
                  >
                    <For each={ZOOM_PRESETS}>
                      {(z) => (
                        <button
                          type="button"
                          onClick={() => {
                            setScale(z / 100);
                            setZoomOpen(false);
                          }}
                          class={`flex h-7 w-full items-center px-3 text-left text-[12px] hover:bg-[var(--color-control-fill)] ${
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
                </>
              </Show>
            </div>
          </Show>
        </div>
      </div>

      <Show when={err() && previewMode() === "pdf"}>
        <div class="px-3 py-2 text-[11px] text-[var(--color-err)]">{err()}</div>
      </Show>

      <Switch>
        <Match when={previewMode() === "ai"}>
          <div class="min-h-0 flex-1 overflow-hidden">
            <AiView />
          </div>
        </Match>
        <Match when={previewMode() === "console"}>
          <div class="min-h-0 flex-1 overflow-hidden">
            <LogsView />
          </div>
        </Match>
        <Match when={previewMode() === "pdf"}>
          {/* Page viewport. `scrollbar-gutter: stable` reserves space for
            the scrollbar even when content doesn't overflow, so switching
            between PDF / Logs / AI modes never reflows the pane width. */}
          <div
            ref={scrollEl!}
            class="scroll min-h-0 flex-1 overflow-auto"
            style={{
              background: "var(--color-overlay-dim)",
              "scrollbar-gutter": "stable",
            }}
          >
        <Show
          when={pages().length > 0}
          fallback={
            <div class="flex h-full items-center justify-center text-[12px] text-fg-3">
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
            {pages().map((canvas, i) => {
              const pageNum = i + 1;
              return (
                <div
                  data-page={pageNum}
                  class="relative"
                  onClick={(e) => handlePageClick(e, pageNum)}
                  onDblClick={(e) => triggerInverseSearch(e, pageNum)}
                  title="Double-click to jump to source"
                >
                  <div class="mono absolute -left-12 top-1.5 select-none text-[10px] text-fg-4">
                    p. {pageNum}
                  </div>
                  <PageCanvas canvas={canvas} />
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
            })}
            <div class="mono mt-2 text-[10px] text-fg-4">
              — end of preview ({totalPages()} pages) —
            </div>
          </div>
        </Show>
          </div>
        </Match>
      </Switch>
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

const ToolbarKbd: Component<{ shortcut: string }> = (props) => {
  // Inline kbd hint used inside the accent-grad Recompile button. Imports
  // shortcutTokens lazily because this file already pulls in pdfjs.
  return (
    <span class="flex items-center gap-0.5">
      {parseShortcut(props.shortcut).map((tok) => (
        <kbd
          class="mono rounded px-1 py-0.5 text-[10px]"
          style={{
            background: "color-mix(in srgb, var(--color-accent-fg) 16%, transparent)",
            color: "var(--color-accent-fg)",
            "line-height": "1",
          }}
        >
          {tok}
        </kbd>
      ))}
    </span>
  );
};

const isMacEnv =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");
const parseShortcut = (s: string): string[] => {
  const parts = s.split("+");
  const out: string[] = [];
  for (const p of parts) {
    const lower = p.toLowerCase();
    if (lower === "mod") out.push(isMacEnv ? "⌘" : "Ctrl");
    else if (lower === "enter") out.push("↵");
    else out.push(p.toUpperCase());
  }
  return out;
};

const PageCanvas: Component<{ canvas: HTMLCanvasElement }> = (props) => {
  let host!: HTMLDivElement;
  onCleanup(() => {
    host?.replaceChildren();
  });
  const setup = (el: HTMLDivElement) => {
    host = el;
    el.replaceChildren(props.canvas);
  };
  return (
    <div
      ref={setup}
      class="rounded-md bg-white shadow-[0_18px_60px_rgba(0,0,0,0.35),0_2px_6px_rgba(0,0,0,0.25)]"
    />
  );
};
