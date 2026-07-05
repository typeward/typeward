import type { Component } from "solid-js";
import { createEffect, on, onCleanup, onMount } from "solid-js";
import {
  adoptExistingPreview,
  listenPreviewUp,
  sendPreviewScroll,
  sendPreviewState,
  type PreviewState,
  type PreviewUp,
} from "~/lib/preview-window/bridge";
import { createPdfAnnotations } from "~/lib/pdf-annotations/mapper";
import {
  compileActiveProject,
  createThreadFromPdfSelection,
  readProjectSource,
  resolveForward,
  syncInverseFromPdfClick,
} from "~/commands/actions";
import {
  compileState,
  lastResult,
  pdfScrollTarget,
  pdfVersion,
  project,
} from "~/stores/editor-store";
import { allThreads, requestThreadPanel } from "~/stores/review-store";
import { previewDetached } from "~/stores/ui-store";
import { accent, theme } from "~/themes/theme-store";

/**
 * Non-visual coordinator for the detached PDF preview window (E11). Mounted
 * once in the editor shell so it stays alive across attach/detach. When
 * detached it mirrors the main window's PDF state to the preview window and
 * services the intents it sends back — the main window remains the single
 * source of truth for compile, SyncTeX, the review store, and files.
 */
export const PreviewBridge: Component = () => {
  // Its own annotation mapper, active only while detached (the in-pane
  // PreviewPane owns the attached case, and is unmounted when detached).
  const annotations = createPdfAnnotations({
    enabled: () =>
      previewDetached() && project()?.format === "latex" && !!lastResult()?.outputPath,
    threads: () => allThreads().filter((t) => t.status === "open"),
    project,
    outputPath: () => lastResult()?.outputPath ?? null,
    pdfVersion,
    getContent: (rel) => {
      const p = project();
      return p ? readProjectSource(p, rel) : Promise.resolve(null);
    },
    resolveForward,
  });

  const snapshot = (): PreviewState => ({
    pdfPath: lastResult()?.outputPath ?? null,
    pdfVersion: pdfVersion(),
    compiling: compileState() === "compiling",
    theme: theme(),
    accent: accent(),
    annotations: annotations(),
  });

  // Re-broadcast the full state on any change while detached (idempotent — the
  // ready handshake sends it too).
  createEffect(() => {
    const state = snapshot();
    if (!previewDetached()) return;
    sendPreviewState(state);
  });

  // Forward-search targets can't reach the (unmounted) in-pane viewer while
  // detached — relay them to the preview window instead.
  createEffect(
    on(
      () => pdfScrollTarget()?.generation ?? 0,
      () => {
        const t = pdfScrollTarget();
        if (t && previewDetached()) {
          sendPreviewScroll({ page: t.page, y: t.y, generation: t.generation });
        }
      },
      { defer: true },
    ),
  );

  const handleUp = (m: PreviewUp) => {
    switch (m.type) {
      case "ready":
        sendPreviewState(snapshot());
        break;
      case "recompile":
        void compileActiveProject();
        break;
      case "inverse":
        void syncInverseFromPdfClick(m.page, m.x, m.y, m.selectedText);
        break;
      case "openThread":
        requestThreadPanel(m.threadId);
        break;
      case "createThread":
        void createThreadFromPdfSelection(m.input);
        break;
    }
  };

  onMount(() => {
    // Recover if a preview window is already open (main-window reload while
    // detached), then service its intents.
    void adoptExistingPreview();
    const un = listenPreviewUp(handleUp);
    onCleanup(() => void un.then((fn) => fn()));
  });

  return null;
};
