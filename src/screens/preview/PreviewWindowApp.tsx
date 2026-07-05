import type { Component } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";
import { PdfViewer } from "~/components/pdf/PdfViewer";
import type { PdfAnnotation } from "~/lib/pdf-annotations/types";
import {
  ACCENTS,
  THEMES,
  setAccent,
  setTheme,
  type Accent,
  type Theme,
} from "~/themes/theme-store";
import { initCustomThemes } from "~/themes/custom-themes";
// Side-effect import: ui-store's createRoot applies density/motion/ambient/
// accent-gradient defaults to <html> so the PDF chrome tokens resolve.
import "~/stores/ui-store";
import {
  listenPreviewScroll,
  listenPreviewState,
  sendPreviewUp,
  type PreviewScroll,
} from "~/lib/preview-window/bridge";

// theme-store applies data-theme/data-accent from localStorage on import; the
// bridge then keeps them in sync with the main window. Custom themes too.
initCustomThemes();

/**
 * The detached PDF preview window (E11). A deliberately slim app — it never
 * imports the editor stores, watcher, LSP, autosave, or cloud sync. All state
 * arrives over the event bridge; every user action is forwarded back up for the
 * main window (the single source of truth) to service.
 */
export const PreviewWindowApp: Component = () => {
  const [pdfPath, setPdfPath] = createSignal<string | null>(null);
  const [pdfVersion, setPdfVersion] = createSignal(0);
  const [compiling, setCompiling] = createSignal(false);
  const [annotations, setAnnotations] = createSignal<PdfAnnotation[]>([]);
  const [scrollTarget, setScrollTarget] = createSignal<PreviewScroll | null>(null);

  onMount(() => {
    const disposers: Array<Promise<() => void>> = [
      listenPreviewState((s) => {
        setPdfPath(s.pdfPath);
        setPdfVersion(s.pdfVersion);
        setCompiling(s.compiling);
        setAnnotations(s.annotations);
        if ((THEMES as readonly string[]).includes(s.theme)) setTheme(s.theme as Theme);
        if ((ACCENTS as readonly string[]).includes(s.accent)) setAccent(s.accent as Accent);
      }),
      listenPreviewScroll((sc) => setScrollTarget(sc)),
    ];
    // Handshake: the main window replies to `ready` with the current state.
    sendPreviewUp({ type: "ready" });
    onCleanup(() => {
      for (const d of disposers) void d.then((fn) => fn());
    });
  });

  const reattach = () => {
    void import("@tauri-apps/api/webviewWindow").then(({ getCurrentWebviewWindow }) =>
      getCurrentWebviewWindow().close(),
    );
  };

  return (
    <div class="relative h-screen w-screen overflow-hidden bg-[var(--color-overlay-dim)]">
      <PdfViewer
        path={pdfPath()}
        version={pdfVersion()}
        compiling={compiling()}
        embedded
        onCompile={() => sendPreviewUp({ type: "recompile" })}
        onPageClick={(page, x, y, selectedText) =>
          sendPreviewUp({ type: "inverse", page, x, y, selectedText })
        }
        onCreateThread={(input) => sendPreviewUp({ type: "createThread", input })}
        onOpenThread={(threadId) => sendPreviewUp({ type: "openThread", threadId })}
        annotations={annotations()}
        scrollTarget={scrollTarget()}
      />
      <button
        type="button"
        onClick={reattach}
        title="Reattach to the main window"
        class="lift glass absolute bottom-3 right-4 z-20 flex h-7 items-center gap-1.5 rounded-full px-3 text-xs text-fg-2 hover:text-fg-1"
        style={{ background: "var(--color-popover-bg)" }}
      >
        Reattach
      </button>
    </div>
  );
};
