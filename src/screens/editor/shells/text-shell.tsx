import Resizable from "corvu/resizable";
import {
  CheckCircle2,
  Loader2,
  X as XIcon,
  XCircle,
} from "lucide-solid";
import type { Component } from "solid-js";
import {
  Index,
  Match,
  Show,
  Suspense,
  Switch,
  createEffect,
  createMemo,
  createSignal,
  lazy,
  on,
  onCleanup,
  onMount,
} from "solid-js";
import { CodeMirror } from "~/components/editor/CodeMirror";
import {
  EditorSidebar,
  type LeftTab,
} from "~/components/editor/EditorSidebar";
import { FormatToolbar } from "~/components/editor/FormatToolbar";
import { LogsDrawer } from "~/components/editor/LogsDrawer";
import { PaneSwitcher } from "~/components/layout/PaneSwitcher";
import { PdfViewer } from "~/components/pdf/PdfViewer";

// Defer the markdown preview stack (katex + markdown-it + dompurify, ~300 KB
// raw) out of the editor's critical chunk — it loads only when a .md tab is
// opened, which is occasional for LaTeX/Typst projects. Named export, hence
// the default-mapping. Lazy-loading changes load timing only, not the
// DOMPurify-sandboxed render path.
const MarkdownPreview = lazy(() =>
  import("~/components/preview/MarkdownPreview").then((m) => ({
    default: m.MarkdownPreview,
  })),
);
import {
  activeFile,
  activeIndex,
  closeFile,
  compileState,
  lastResult,
  openFiles,
  pdfScrollTarget,
  pdfVersion,
  project,
  setActiveIndex,
  updateActiveFile,
} from "~/stores/editor-store";
import { LIGHT_THEMES, theme } from "~/themes/theme-store";
import { cursorCol, cursorLine } from "~/stores/editor-view-store";
import { editorSettings, integrationsSettings } from "~/stores/settings-store";
import { harperLinter } from "~/lib/grammar/cm6";
import { reviewExtension, syncThreadsToView } from "~/lib/reviews/cm6";
import {
  allThreads,
  updateThreadOffsets,
  requestReviewPanel,
  setRequestReviewPanel,
} from "~/stores/review-store";
import type { EditorView } from "@codemirror/view";
import {
  grammarSyntaxForLanguage,
  languageForFile,
  lspLanguageForFile,
  previewKindForFile,
} from "~/adapters/languages";
import {
  consolePosition,
  editorLayout,
  focusMode,
  previewMode,
  setPreviewMode,
  toggleFocusMode,
} from "~/stores/ui-store";
import {
  activePane,
  cyclePane,
  isTabletViewport,
  logsSheetOpen,
  setActivePane,
  setLogsSheetOpen,
} from "~/stores/viewport-store";
import {
  compileActiveProject,
  saveActiveFile,
  syncInverseFromPdfClick,
} from "~/commands/actions";
import { errorText, notifyError } from "~/components/feedback/Toaster";
import { installSwipeListener } from "~/lib/gestures";
import { pathToFileUri } from "~/lib/lsp/cm6";
import { createSidebarResize } from "~/lib/sidebar-resize";
import { findSession } from "~/stores/lsp-store";

export const TextShell: Component<{
  onSelectFile: (relPath: string) => void;
}> = (props) => {
  const [leftTab, setLeftTab] = createSignal<LeftTab>("files");
  const [outlineCollapsed, setOutlineCollapsed] = createSignal(false);

  const handleEditorChange = (next: string) => {
    const file = activeFile();
    if (!file) return;
    if (file.content === next) return;
    updateActiveFile({ content: next, dirty: true });
  };

  const save = () =>
    void saveActiveFile().catch((e) =>
      notifyError("Couldn't save file", errorText(e)),
    );
  const compile = () => void compileActiveProject();

  // Surface diagnostics on compile failure. When the console lives in the
  // PDF pane, the stale PDF would otherwise keep showing with no hint that
  // anything went wrong (the LogsDrawer handles its own expand).
  createEffect(
    on(compileState, (state) => {
      if (state === "error" && consolePosition() === "pdf-tab") {
        setPreviewMode("console");
      }
    }),
  );

  // `review.togglePanel` (command palette) and the editor's review-gutter
  // click both raise the requestReviewPanel intent; the sidebar tab state
  // lives here. Mirrors the requestNewProject/requestSaveTemplate pattern.
  createEffect(() => {
    if (!requestReviewPanel()) return;
    setLeftTab("review");
    if (isTabletViewport()) setActivePane("sidebar");
    setRequestReviewPanel(false);
  });

  const pdfPath = createMemo(() => lastResult()?.outputPath ?? null);

  const previewKind = createMemo<"markdown" | "pdf">(() => {
    const f = activeFile();
    return f ? previewKindForFile(f.relPath) : "pdf";
  });

  const mdBaseDir = createMemo<string>(() => {
    const f = activeFile();
    const p = project();
    if (!f || !p) return p?.rootPath ?? "";
    const segs = f.relPath.replace(/\\/g, "/").split("/");
    segs.pop();
    return [p.rootPath.replace(/\\/g, "/"), ...segs].filter(Boolean).join("/");
  });

  const mdTheme = createMemo<"dark" | "light">(() =>
    (LIGHT_THEMES as readonly string[]).includes(theme()) ? "light" : "dark"
  );

  const handleSelectFile = (rel: string) => {
    props.onSelectFile(rel);
    // On tablet, picking a file should swap to the editor pane — keeping the
    // sidebar mounted would just hide the file the user just opened.
    if (isTabletViewport()) setActivePane("editor");
  };

  return (
    <Show
      when={!isTabletViewport()}
      fallback={
        <TabletLayout
          leftTab={leftTab()}
          setLeftTab={setLeftTab}
          outlineCollapsed={outlineCollapsed()}
          setOutlineCollapsed={setOutlineCollapsed}
          onSelectFile={handleSelectFile}
          onSave={save}
          onCompile={compile}
          onEditorChange={handleEditorChange}
          pdfPath={pdfPath()}
          previewKind={previewKind()}
          mdBaseDir={mdBaseDir()}
          mdTheme={mdTheme()}
        />
      }
    >
      <DesktopLayout
        leftTab={leftTab()}
        setLeftTab={setLeftTab}
        outlineCollapsed={outlineCollapsed()}
        setOutlineCollapsed={setOutlineCollapsed}
        onSelectFile={handleSelectFile}
        onSave={save}
        onCompile={compile}
        onEditorChange={handleEditorChange}
        pdfPath={pdfPath()}
        previewKind={previewKind()}
        mdBaseDir={mdBaseDir()}
        mdTheme={mdTheme()}
      />
    </Show>
  );
};

// =================================================================
// Shared shell-prop bag
// =================================================================

interface ShellProps {
  leftTab: LeftTab;
  setLeftTab: (t: LeftTab) => void;
  outlineCollapsed: boolean;
  setOutlineCollapsed: (fn: (v: boolean) => boolean) => void;
  onSelectFile: (relPath: string) => void;
  onSave: () => void;
  onCompile: () => void;
  onEditorChange: (v: string) => void;
  pdfPath: string | null;
  previewKind: "markdown" | "pdf";
  mdBaseDir: string;
  mdTheme: "dark" | "light";
}

// =================================================================
// Right pane — the single owner of the markdown-vs-PDF decision, shared
// verbatim by the desktop and tablet layouts (it used to be duplicated).
// =================================================================

const PreviewPane: Component<{
  previewKind: "markdown" | "pdf";
  pdfPath: string | null;
  mdBaseDir: string;
  mdTheme: "dark" | "light";
  onCompile: () => void;
}> = (props) => {
  // Show the in-app .md preview only when a markdown tab is active AND the pane
  // is in its default "pdf" mode. Console/AI (and any future pane mode) live
  // inside PdfViewer, so mount it for those even over a markdown file —
  // otherwise the compile-error -> console redirect (see the effect in
  // TextShell) would silently no-op whenever a .md tab happened to be active.
  const showMarkdown = () =>
    props.previewKind === "markdown" && previewMode() === "pdf";
  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      <Switch>
        <Match when={showMarkdown()}>
          <Suspense fallback={null}>
            <MarkdownPreview
              content={() => activeFile()?.content ?? ""}
              baseDir={props.mdBaseDir}
              theme={() => props.mdTheme}
            />
          </Suspense>
        </Match>
        <Match when={!showMarkdown()}>
          <PdfViewer
            path={props.pdfPath}
            version={pdfVersion()}
            onCompile={props.onCompile}
            compiling={compileState() === "compiling"}
            scrollTarget={pdfScrollTarget()}
            onPageClick={(page, x, y) => {
              void syncInverseFromPdfClick(page, x, y);
            }}
          />
        </Match>
      </Switch>
    </div>
  );
};

// =================================================================
// Desktop layout — three corvu Resizable panes (existing behavior)
// =================================================================

const DesktopLayout: Component<ShellProps> = (props) => {
  const showEditor = () => editorLayout() !== "preview";
  const showPreview = () => editorLayout() !== "editor";
  const showDrawer = () => consolePosition() === "drawer";

  // The sidebar's initial width fits the full tab strip (measured by
  // EditorSidebar) so Files / Refs / SCM / Review·n / TODO·n all show without
  // clipping; the user can still drag from there.
  const [tabsWidth, setTabsWidth] = createSignal<number | undefined>();
  const sidebar = createSidebarResize({
    minPx: 200,
    maxPx: 400,
    defaultPx: 260,
    desiredPx: () => {
      const w = tabsWidth();
      return w ? w + 4 : undefined;
    },
  });

  const editorPane = () => (
    <CenterPane
      onSave={props.onSave}
      onCompile={props.onCompile}
      onEditorChange={props.onEditorChange}
    />
  );
  const previewPane = () => (
    <PreviewPane
      previewKind={props.previewKind}
      pdfPath={props.pdfPath}
      mdBaseDir={props.mdBaseDir}
      mdTheme={props.mdTheme}
      onCompile={props.onCompile}
    />
  );

  // Focus mode strips the chrome down to source + page. A separate branch
  // (rather than conditional Resizable panels) keeps the sidebar-resize
  // size bookkeeping out of the picture entirely.
  const focusLayout = () => (
    <div class="relative flex h-full w-full overflow-hidden" data-editor-shell>
      <Switch>
        <Match when={showEditor() && showPreview()}>
          <Resizable orientation="horizontal" class="flex min-h-0 flex-1 overflow-hidden">
            <Resizable.Panel initialSize={0.55} minSize={0.3}>
              {editorPane()}
            </Resizable.Panel>
            <Resizable.Handle aria-label="Resize preview" class="group relative w-[6px] shrink-0">
              <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
            </Resizable.Handle>
            <Resizable.Panel initialSize={0.45} minSize="320px">
              {previewPane()}
            </Resizable.Panel>
          </Resizable>
        </Match>
        <Match when={showEditor()}>
          <div class="flex min-h-0 flex-1">{editorPane()}</div>
        </Match>
        <Match when={showPreview()}>
          <div class="flex min-h-0 flex-1">{previewPane()}</div>
        </Match>
      </Switch>
      <button
        type="button"
        onClick={() => toggleFocusMode()}
        title="Exit focus mode (Mod+Shift+F)"
        class="lift absolute bottom-3 right-4 z-20 flex h-7 items-center gap-1.5 rounded-full px-2.5 text-xs text-fg-3 opacity-50 hover:opacity-100"
        style={{
          background: "var(--color-popover-bg)",
          border: "1px solid var(--color-glass-stroke)",
        }}
      >
        Exit focus
      </button>
    </div>
  );

  return (
    <Show when={!focusMode()} fallback={focusLayout()}>
    <Resizable
      ref={sidebar.setRef}
      orientation="horizontal"
      class="flex h-full w-full overflow-hidden"
      data-editor-shell
      sizes={sidebar.sizes()}
      onSizesChange={sidebar.onSizesChange}
    >
      {/* min-w-0 zeroes the panel's flex auto-minimum so wide tab content
          (long reference titles, search results) can't grow the pane past its
          corvu-controlled size; overflow-hidden clips the rest. */}
      <Resizable.Panel minSize="200px" maxSize="400px" class="min-w-0 overflow-hidden">
        <EditorSidebar
          tab={props.leftTab}
          setTab={props.setLeftTab}
          outlineCollapsed={props.outlineCollapsed}
          setOutlineCollapsed={props.setOutlineCollapsed}
          onSelectFile={props.onSelectFile}
          onTabsMeasured={setTabsWidth}
        />
      </Resizable.Panel>

      <Resizable.Handle
        aria-label="Resize sidebar"
        class="group relative w-[6px] shrink-0"
      >
        <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
      </Resizable.Handle>

      <Resizable.Panel minSize={0.4}>
        <div class="flex h-full flex-col gap-2">
          <Switch>
            <Match when={showEditor() && showPreview()}>
              <Resizable
                orientation="horizontal"
                class="flex min-h-0 flex-1 overflow-hidden"
              >
                <Resizable.Panel initialSize={0.55} minSize={0.3}>
                  {editorPane()}
                </Resizable.Panel>
                <Resizable.Handle
                  aria-label="Resize preview"
                  class="group relative w-[6px] shrink-0"
                >
                  <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
                </Resizable.Handle>
                <Resizable.Panel initialSize={0.45} minSize="320px">
                  {previewPane()}
                </Resizable.Panel>
              </Resizable>
            </Match>
            <Match when={showEditor()}>
              <div class="flex min-h-0 flex-1">{editorPane()}</div>
            </Match>
            <Match when={showPreview()}>
              <div class="flex min-h-0 flex-1">{previewPane()}</div>
            </Match>
          </Switch>

          <Show when={showDrawer()}>
            <LogsDrawer />
          </Show>
        </div>
      </Resizable.Panel>
    </Resizable>
    </Show>
  );
};

// =================================================================
// Tablet layout — single pane + bottom switcher + swipe gestures
// =================================================================

const TabletLayout: Component<ShellProps> = (props) => {
  let rootRef: HTMLDivElement | undefined;

  onMount(() => {
    if (!rootRef) return;
    const teardown = installSwipeListener(rootRef, (direction) => {
      cyclePane(direction);
    });
    onCleanup(teardown);
  });

  return (
    <div
      ref={rootRef}
      class="relative flex h-full w-full flex-col gap-2 overflow-hidden"
      data-editor-shell
    >
      <div class="min-h-0 flex-1 px-2">
        <Switch>
          <Match when={activePane() === "sidebar"}>
            <EditorSidebar
              tab={props.leftTab}
              setTab={props.setLeftTab}
              outlineCollapsed={props.outlineCollapsed}
              setOutlineCollapsed={props.setOutlineCollapsed}
              onSelectFile={props.onSelectFile}
            />
          </Match>
          <Match when={activePane() === "editor"}>
            <CenterPane
              onSave={props.onSave}
              onCompile={props.onCompile}
              onEditorChange={props.onEditorChange}
            />
          </Match>
          <Match when={activePane() === "preview"}>
            <PreviewPane
              previewKind={props.previewKind}
              pdfPath={props.pdfPath}
              mdBaseDir={props.mdBaseDir}
              mdTheme={props.mdTheme}
              onCompile={props.onCompile}
            />
          </Match>
        </Switch>
      </div>

      <PaneSwitcher />
      <LogsSheet />
    </div>
  );
};

// =================================================================
// LogsSheet — slide-up overlay variant of LogsDrawer for tablet mode
// =================================================================

const LogsSheet: Component = () => {
  // Escape closes the sheet for keyboard-attached tablets.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && logsSheetOpen()) {
      e.stopPropagation();
      setLogsSheetOpen(false);
    }
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  return (
    <Show when={logsSheetOpen()}>
      {/* Backdrop dims the pane behind the sheet; tapping closes it. */}
      <button
        type="button"
        aria-label="Close logs"
        onClick={() => setLogsSheetOpen(false)}
        class="absolute inset-0 z-30 bg-[var(--color-overlay-scrim)] backdrop-blur-[1px]"
      />
      <div
        class="absolute inset-x-2 bottom-2 z-40 flex max-h-[55vh] flex-col overflow-hidden rounded-xl"
        role="dialog"
        aria-label="Logs"
      >
        <LogsDrawer />
      </div>
    </Show>
  );
};

// =================================================================
// Center pane — file tabs, editor, status bar, problems
// =================================================================

const CenterPane: Component<{
  onSave: () => void;
  onCompile: () => void;
  onEditorChange: (v: string) => void;
}> = (props) => {
  const tabHeight = () => (isTabletViewport() ? "h-12" : "h-9");
  const tabRowHeight = () => (isTabletViewport() ? "h-11" : "h-7");

  // Key the editor on more than the file path: the keyed <Show> reads sessions
  // and the grammar setting untracked, so an LSP handshake that completes after
  // CodeMirror mounts — or a grammar toggle — would otherwise never attach to
  // the open file. Folding session-readiness + grammar state into the key makes
  // the editor remount (and re-run didOpen) exactly when they change.
  const editorKey = createMemo<string | null>(() => {
    const f = activeFile();
    if (!f?.path) return null;
    const lspLang = lspLanguageForFile(f.relPath);
    const lspReady = lspLang ? !!findSession(lspLang) : false;
    const grammarOn = integrationsSettings().grammar.enabled;
    return `${f.path}::${lspReady ? "lsp" : "nolsp"}::${grammarOn ? "g1" : "g0"}`;
  });

  // Closing a dirty tab would silently discard the buffer (the autosave
  // snapshot only resurfaces on the next project open) — confirm first.
  const requestCloseFile = async (index: number) => {
    const f = openFiles()[index];
    if (f?.dirty) {
      let discard = false;
      try {
        const { ask } = await import("@tauri-apps/plugin-dialog");
        discard = await ask(
          `"${f.relPath}" has unsaved changes. Close it and discard them?`,
          {
            title: "Unsaved changes",
            kind: "warning",
            okLabel: "Discard changes",
            cancelLabel: "Keep open",
          },
        );
      } catch {
        discard = window.confirm(
          `"${f.relPath}" has unsaved changes. Close and discard?`,
        );
      }
      if (!discard) return;
    }
    closeFile(index);
  };

  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      {/* File tabs strip — hidden in focus mode along with the toolbar. */}
      <Show when={!focusMode()}>
      <div
        role="tablist"
        aria-label="Open files"
        onKeyDown={(e) => {
          // APG tabs pattern: arrows move + activate within the roving
          // tabindex; without this, inactive tabs are keyboard-unreachable.
          const count = openFiles().length;
          if (count === 0) return;
          let next: number;
          if (e.key === "ArrowLeft") next = (activeIndex() - 1 + count) % count;
          else if (e.key === "ArrowRight") next = (activeIndex() + 1) % count;
          else if (e.key === "Home") next = 0;
          else if (e.key === "End") next = count - 1;
          else return;
          e.preventDefault();
          setActiveIndex(next);
          const tabs =
            e.currentTarget.querySelectorAll<HTMLElement>('[role="tab"]');
          tabs[next]?.focus();
        }}
        class={`flex ${tabHeight()} flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-glass-stroke px-2 scroll`}
      >
        <Show
          when={openFiles().length > 0}
          fallback={
            <span class="px-2 text-sm text-fg-3">No file open</span>
          }
        >
          <Index each={openFiles()}>
            {(f, i) => {
              const active = () => activeIndex() === i;
              return (
                <div
                  role="tab"
                  aria-selected={active()}
                  tabIndex={active() ? 0 : -1}
                  onClick={() => setActiveIndex(i)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setActiveIndex(i);
                    }
                  }}
                  class={`lift flex ${tabRowHeight()} flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 text-sm font-medium ${
                    active() ? "text-fg-1" : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                  }`}
                  style={
                    active()
                      ? {
                          background: "var(--color-control-fill)",
                          border: "1px solid color-mix(in srgb, var(--color-accent-1) 25%, transparent)",
                        }
                      : undefined
                  }
                >
                  <span class="mono max-w-[220px] truncate" title={f().relPath}>
                    {f().relPath}
                  </span>
                  <Show when={f().dirty}>
                    <span
                      class="h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--color-accent-1)" }}
                    />
                  </Show>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      void requestCloseFile(i);
                    }}
                    class={`-mr-1 flex items-center justify-center rounded opacity-60 hover:bg-[var(--color-control-fill-hover)] hover:opacity-100 ${
                      isTabletViewport() ? "h-11 w-11" : "h-6 w-6"
                    }`}
                    aria-label={`Close ${f().relPath}`}
                  >
                    <XIcon size={isTabletViewport() ? 16 : 12} />
                  </button>
                </div>
              );
            }}
          </Index>
        </Show>
        {/* Save + Compile buttons were removed 2026-05-15. Save is on Mod+S;
            Compile is the PDF panel's Recompile button. */}
      </div>
      </Show>

      <Show when={activeFile() && !focusMode()}>
        <FormatToolbar />
      </Show>

      <div class="min-h-0 flex-1 overflow-hidden">
        <Show
          when={editorKey()}
          keyed
          fallback={
            <div class="flex h-full items-center justify-center text-sm text-fg-3">
              Open a file from the sidebar.
            </div>
          }
        >
          {(_key) => {
            const f = activeFile()!;
            const lang = languageForFile(f.relPath);
            const lspLang = lspLanguageForFile(f.relPath);
            const lspSession = lspLang ? findSession(lspLang) : undefined;
            const extras = lspSession
              ? lspSession.document({
                  uri: pathToFileUri(f.path),
                  languageId: lang,
                }) ?? []
              : [];
            const grammarOn = integrationsSettings().grammar.enabled;
            const extrasList = Array.isArray(extras) ? extras : [extras];
            const grammarExt = grammarOn
              ? [harperLinter({ syntax: grammarSyntaxForLanguage(lang), file: f.relPath })]
              : [];
            const reviewExt = reviewExtension({
              // Close over the file captured at mount, not the global active
              // file at debounce-fire time: the editor is keyed per file, so
              // this closure always belongs to the file it was created for.
              onOffsetsChanged: (updates) =>
                updateThreadOffsets(
                  f.relPath,
                  updates.map((u) => ({
                    id: u.id,
                    fromOffset: u.from,
                    toOffset: u.to,
                    anchorText: u.anchorText,
                  })),
                ),
              onGutterClick: () => setRequestReviewPanel(true),
            });
            // The review store is the single source of truth for anchors; the
            // CM decorations are derived. Seed on ready and re-derive on any
            // store change (add / resolve / reopen / delete / re-anchor) so the
            // gutter never shows a stale open/resolved state after a mutation.
            const [reviewView, setReviewView] = createSignal<EditorView | null>(
              null,
            );
            createEffect(() => {
              const v = reviewView();
              const threads = allThreads();
              if (!v) return;
              syncThreadsToView(v, threads, f.relPath, activeFile()?.content ?? f.content);
            });
            return (
              <CodeMirror
                value={f.content}
                onChange={props.onEditorChange}
                language={lang}
                fontSize={editorSettings().fontSize}
                lineWrap={editorSettings().lineWrap}
                vimMode={editorSettings().vimMode}
                lspActive={!!lspSession}
                onReady={setReviewView}
                extraExtensions={[...extrasList, ...grammarExt, ...reviewExt]}
              />
            );
          }}
        </Show>
      </div>

      <Show when={!focusMode()}>
        <StatusBar />
      </Show>
    </div>
  );
};

const StatusBar: Component = () => {
  const file = activeFile;
  const lnCol = () => {
    const l = cursorLine();
    const c = cursorCol();
    if (l == null || c == null) return null;
    return `Ln ${l}, Col ${c}`;
  };
  return (
    <div class="mono flex h-6 flex-shrink-0 items-center gap-3 border-t border-glass-stroke px-3 text-xs text-fg-3">
      <Show when={file()}>
        <Show when={lnCol()} fallback={<span class="opacity-60">Ln —, Col —</span>}>
          <span>{lnCol()}</span>
        </Show>
        <span class="opacity-50">·</span>
        <span class="capitalize">{languageForFile(file()!.relPath)}</span>
        <span class="opacity-50">·</span>
        <span>UTF-8</span>
      </Show>
      <span class="ml-auto flex items-center gap-1.5">
        <CompileIndicator />
      </span>
    </div>
  );
};

const CompileIndicator: Component = () => (
  <Show when={lastResult()}>
    <span
      class={`inline-flex items-center gap-1 ${
        compileState() === "ok"
          ? "text-[var(--color-ok)]"
          : compileState() === "error"
            ? "text-[var(--color-err)]"
            : "text-fg-3"
      }`}
    >
      <Show when={compileState() === "ok"}>
        <CheckCircle2 size={12} />
      </Show>
      <Show when={compileState() === "error"}>
        <XCircle size={12} />
      </Show>
      <Show when={compileState() === "compiling"}>
        <Loader2 size={12} class="animate-spin" />
      </Show>
      {lastResult()!.durationMs}ms
    </span>
  </Show>
);
