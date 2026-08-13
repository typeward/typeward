import Resizable from "corvu/resizable";
import {
  CheckCircle2,
  Files,
  ListX,
  Loader2,
  SpellCheck,
  SquareX,
  X as XIcon,
  XCircle,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import {
  For,
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
import { BuildMenu } from "~/components/editor/BuildMenu";
import { perfMeasure } from "~/lib/perf-marks";
import { ProjectSettingsDialog } from "~/components/editor/ProjectSettingsDialog";
import { CodeMirror } from "~/components/editor/CodeMirror";
import {
  ContextMenu,
  ContextMenuItem,
  createContextMenuState,
} from "~/components/primitives/ContextMenu";
import { IconButton } from "~/components/primitives/IconButton";
import { EditorContextMenu } from "~/components/editor/context-menu/EditorContextMenu";
import {
  buildEditorMenuContext,
  type EditorMenuContext,
} from "~/components/editor/context-menu/registry";
import {
  EditorSidebar,
  type LeftTab,
} from "~/components/editor/EditorSidebar";
import { FormatToolbar } from "~/components/editor/FormatToolbar";
import { LogsDrawer } from "~/components/editor/LogsDrawer";
import { PaneSwitcher } from "~/components/layout/PaneSwitcher";
import { PdfViewer } from "~/components/pdf/PdfViewer";
import { PreviewBridge } from "~/components/pdf/PreviewBridge";

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
  consumeScrollAnchor,
  lastResult,
  openFiles,
  updateFileContentByPath,
  pdfScrollTarget,
  pdfVersion,
  project,
  setActiveIndex,
  setPdfViewportTop,
  updateActiveFile,
} from "~/stores/editor-store";
import { LIGHT_THEMES, theme } from "~/themes/theme-store";
import {
  cursorCol,
  cursorLine,
  getActiveEditorView,
} from "~/stores/editor-view-store";
import {
  editorSettings,
  integrationsSettings,
  LINE_HEIGHT_VALUES,
} from "~/stores/settings-store";
import { harperLinter } from "~/lib/grammar/cm6";
import { clearGrammarDiagnostics, grammarTotalCount } from "~/stores/grammar-store";
import { asGrammarDialect } from "~/ipc";
import { reviewExtension, syncThreadsToView } from "~/lib/reviews/cm6";
import {
  allThreads,
  updateThreadOffsets,
  reviewPanelIntent,
  setReviewPanelIntent,
  setFocusedThreadId,
  requestThreadPanel,
} from "~/stores/review-store";
import { createPdfAnnotations } from "~/lib/pdf-annotations/mapper";
import type { EditorView } from "@codemirror/view";
import {
  grammarSyntaxForLanguage,
  isVisualEligibleFile,
  languageForFile,
  lspLanguageForFile,
  previewKindForFile,
} from "~/adapters/languages";
import {
  markVisualPaused,
  requestVisualPopover,
  visualPaused,
  visualPopoverIntent,
} from "~/stores/visual-store";
import { VisualPopover } from "~/components/editor/visual/VisualPopover";
import { ReviewComposePopover } from "~/components/reviews/ReviewComposePopover";
import { resolveProjectAsset } from "~/lib/file-url";
import {
  centerSplit,
  consolePosition,
  editorLayout,
  focusMode,
  previewDetached,
  previewMode,
  requestLogsTab,
  revealCompileErrors,
  setCenterSplit,
  setPreviewMode,
  setSidebarPx,
  setTabActionIntent,
  sidebarPx,
  tabActionIntent,
  toggleFocusMode,
} from "~/stores/ui-store";
import {
  activePane,
  cyclePane,
  logsSheetOpen,
  paneTier,
  setActivePane,
  setLogsSheetOpen,
  touchAffordances,
} from "~/stores/viewport-store";
import {
  cancelActiveCompile,
  compileActiveProject,
  compileStartedAt,
  createThreadFromPdfSelection,
  readProjectSource,
  resolveForward,
  saveActiveFile,
  syncInverseFromPdfClick,
} from "~/commands/actions";
import { errorText, notifyError } from "~/components/feedback/Toaster";
import { installSwipeListener } from "~/lib/gestures";
import { pathToFileUri } from "~/lib/lsp/cm6";
import { refCiteCompletionExtension } from "~/lib/lsp/ref-cite-completion";
import { refCiteGotoExtension } from "~/lib/lsp/ref-cite-goto";
import { refDiagnosticsExtension } from "~/lib/lsp/ref-diagnostics";
import {
  prunePool,
  withActiveEntry,
  type PoolEntry,
} from "~/screens/editor/editor-pool";
import { anchoredMenuEvent } from "~/lib/menu-position";
import { createSidebarResize } from "~/lib/sidebar-resize";
import { findSession } from "~/stores/lsp-store";

// Off means zero grammar UI and zero grammar IPC.
const grammarActive = () => integrationsSettings().grammar.enabled;

export const TextShell: Component<{
  onSelectFile: (relPath: string) => void;
}> = (props) => {
  const [leftTab, setLeftTab] = createSignal<LeftTab>("files");
  const [outlineCollapsed, setOutlineCollapsed] = createSignal(false);
  // Two-pane tier only: the sidebar lives in an overlay drawer. Owned here
  // (not in TwoPaneLayout) so the sidebar-targeting intents below can raise it.
  const [filesDrawerOpen, setFilesDrawerOpen] = createSignal(false);

  // Leaving the two-pane tier drops the drawer overlay so a later resize back
  // into it doesn't reopen a stale drawer (mirrors the logs-sheet reset in
  // viewport-store).
  createEffect(() => {
    if (paneTier() !== "two") setFilesDrawerOpen(false);
  });

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
  // click both raise the review-panel intent; the sidebar tab state lives here.
  // A threadId on the intent is handed to `focusedThreadId` so the panel can
  // scroll to + expand it. Mirrors the requestNewProject pattern.
  createEffect(() => {
    const intent = reviewPanelIntent();
    if (!intent) return;
    setLeftTab(intent.panel);
    // The sidebar is docked on three panes, an overlay drawer on two, and a
    // swappable pane on one — the intent must surface it on all three.
    if (paneTier() === "one") setActivePane("sidebar");
    else if (paneTier() === "two") setFilesDrawerOpen(true);
    setFocusedThreadId(intent.threadId ?? null);
    setReviewPanelIntent(null);
  });

  // `core.fileHistory` now opens the top-bar HistoryMenu popover — the
  // intent is consumed there (components/editor/HistoryMenu.tsx).

  // The grammar linter mirrors its results into a cross-file store (read by
  // the Logs Grammar tab). Drop them when grammar is switched off or the
  // project changes, so stale entries from another project/session never show.
  let lastGrammarRoot: string | undefined;
  createEffect(() => {
    const root = project()?.rootPath;
    const grammarOn = grammarActive();
    if (!grammarOn || root !== lastGrammarRoot) clearGrammarDiagnostics();
    lastGrammarRoot = root;
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
    // On the single-pane tier, picking a file should swap to the editor pane —
    // keeping the sidebar mounted would just hide the file the user just
    // opened. The two-pane files drawer closes for the same reason.
    if (paneTier() === "one") setActivePane("editor");
    setFilesDrawerOpen(false);
  };

  return (
    <>
      {/* Non-visual: mirrors PDF state to the detached preview window (E11).
          Mounted here so it survives attach/detach and layout switches. */}
      <PreviewBridge />
      {/* Single per-project settings dialog, raised by the sidebar gear, the
          engine pill's menu, and the status-bar build menu. */}
      <ProjectSettingsDialog />
      <Switch>
        <Match when={paneTier() === "three"}>
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
        </Match>
        <Match when={paneTier() === "two"}>
          <TwoPaneLayout
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
            filesDrawerOpen={filesDrawerOpen()}
            setFilesDrawerOpen={setFilesDrawerOpen}
          />
        </Match>
        <Match when={paneTier() === "one"}>
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
        </Match>
      </Switch>
    </>
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

  // In-PDF review/TODO highlights (E10c): open threads SyncTeX-forwarded to
  // page geometry. Only maps LaTeX projects while the PDF is actually showing.
  const annotations = createPdfAnnotations({
    enabled: () =>
      !showMarkdown() &&
      previewMode() === "pdf" &&
      project()?.format === "latex" &&
      !!props.pdfPath,
    threads: () => allThreads().filter((t) => t.status === "open"),
    project,
    outputPath: () => props.pdfPath,
    pdfVersion,
    getContent: (rel) => {
      const p = project();
      return p ? readProjectSource(p, rel) : Promise.resolve(null);
    },
    resolveForward,
  });

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
            onCancelCompile={() => void cancelActiveCompile()}
            compileStartedAt={compileStartedAt()}
            stale={compileState() === "error" && props.pdfPath !== null}
            fromLastBuild={lastResult()?.seeded === true}
            onShowErrors={revealCompileErrors}
            scrollTarget={pdfScrollTarget()}
            onViewportTop={(page, y) => setPdfViewportTop({ page, y })}
            consumeScrollAnchor={() => {
              const a = consumeScrollAnchor();
              return a ? { relPath: a.relPath, line: a.line } : null;
            }}
            resolveScrollAnchor={async (relPath, line) => {
              const p = project();
              const out = lastResult()?.outputPath;
              if (!p || !out) return null;
              const loc = await resolveForward(p, out, relPath, line);
              return loc ? { page: loc.page, y: loc.y } : null;
            }}
            onPageClick={(page, x, y, selectedText) => {
              void syncInverseFromPdfClick(page, x, y, selectedText);
            }}
            onCreateThread={(input) => void createThreadFromPdfSelection(input)}
            onOpenThread={(threadId) => requestThreadPanel(threadId)}
            annotations={annotations()}
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
  // When the preview is detached into its own window, the in-pane preview
  // collapses and the editor takes the full width (forced visible even in the
  // preview-only layout so the pane is never left blank).
  const showEditor = () => editorLayout() !== "preview" || previewDetached();
  const showPreview = () => editorLayout() !== "editor" && !previewDetached();
  const showDrawer = () => consolePosition() === "drawer";

  // The sidebar's initial width fits the full tab strip (measured by
  // EditorSidebar) so Files / Refs / SCM / Review·n / TODO·n all show without
  // clipping; the user can still drag from there. Once the user HAS dragged,
  // the persisted width (workspace.sidebarPx) wins over the content fit —
  // reactive through desiredPx, so the async settings hydrate still applies.
  const [tabsWidth, setTabsWidth] = createSignal<number | undefined>();
  // Default/floor width of the left sidebar until the user drags the handle.
  const SIDEBAR_DEFAULT_PX = 340;
  const clampSidebar = (px: number) => Math.min(440, Math.max(200, px));
  const fittedWidth = () => {
    const w = tabsWidth();
    return w ? Math.max(w + 4, SIDEBAR_DEFAULT_PX) : undefined;
  };
  // True only while the resize handle is held down. corvu echoes programmatic
  // sizes (initial mount, window-resize reflow, the panel's min-clamped first
  // paint) through onSizesChange too, and no value comparison can tell those
  // from a drag — boot echoes used to persist phantom widths (a min-clamped
  // 200, or the old default minus a scrollbar) and permanently freeze the
  // content-fit behavior. The pointer is the only honest signal.
  const [sidebarDragging, setSidebarDragging] = createSignal(false);
  const beginSidebarDrag = () => {
    setSidebarDragging(true);
    const end = () => setSidebarDragging(false);
    window.addEventListener("pointerup", end, { once: true });
    window.addEventListener("pointercancel", end, { once: true });
  };
  const sidebar = createSidebarResize({
    minPx: 200,
    maxPx: 440,
    defaultPx: sidebarPx() ?? SIDEBAR_DEFAULT_PX,
    desiredPx: () => sidebarPx() ?? fittedWidth(),
    isDragging: sidebarDragging,
  });
  // Mirror genuine drags into the persisted signal; anything reported while
  // the handle is not held down is an echo and must not touch settings.
  let resizableEl: HTMLDivElement | undefined;
  const onSidebarSizesChange = (next: number[]) => {
    sidebar.onSizesChange(next);
    if (!sidebarDragging()) return;
    const w = resizableEl?.getBoundingClientRect().width ?? 0;
    if (w <= 0 || next[0] === undefined) return;
    setSidebarPx(Math.round(clampSidebar(next[0] * w)));
  };

  // Editor/preview split — one persisted fraction (workspace.centerSplit)
  // shared by the normal and focus-mode layouts, so entering/leaving focus
  // (or relaunching) no longer resets the split.
  const splitSizes = () => [centerSplit(), 1 - centerSplit()];
  const onSplitSizesChange = (next: number[]) => {
    if (next[0] === undefined || next[0] <= 0) return;
    // Round so drag micro-jitter doesn't churn the debounced settings save.
    setCenterSplit(Math.round(next[0] * 1000) / 1000);
  };

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
          <Resizable
            orientation="horizontal"
            class="flex min-h-0 flex-1 overflow-hidden"
            sizes={splitSizes()}
            onSizesChange={onSplitSizesChange}
          >
            <Resizable.Panel minSize={0.3}>
              {editorPane()}
            </Resizable.Panel>
            <Resizable.Handle aria-label="Resize preview" class="group relative w-[6px] shrink-0">
              <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
            </Resizable.Handle>
            <Resizable.Panel minSize="320px">
              {previewPane()}
            </Resizable.Panel>
          </Resizable>
        </Match>
        <Match when={showEditor()}>
          <div class="min-h-0 flex-1">{editorPane()}</div>
        </Match>
        <Match when={showPreview()}>
          <div class="min-h-0 flex-1">{previewPane()}</div>
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
      ref={(el: HTMLDivElement) => {
        resizableEl = el;
        sidebar.setRef(el);
      }}
      orientation="horizontal"
      class="flex h-full w-full overflow-hidden"
      data-editor-shell
      sizes={sidebar.sizes()}
      onSizesChange={onSidebarSizesChange}
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
        onPointerDown={beginSidebarDrag}
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
                sizes={splitSizes()}
                onSizesChange={onSplitSizesChange}
              >
                <Resizable.Panel minSize={0.3}>
                  {editorPane()}
                </Resizable.Panel>
                <Resizable.Handle
                  aria-label="Resize preview"
                  class="group relative w-[6px] shrink-0"
                >
                  <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
                </Resizable.Handle>
                <Resizable.Panel minSize="320px">
                  {previewPane()}
                </Resizable.Panel>
              </Resizable>
            </Match>
            <Match when={showEditor()}>
              <div class="min-h-0 flex-1">{editorPane()}</div>
            </Match>
            <Match when={showPreview()}>
              <div class="min-h-0 flex-1">{previewPane()}</div>
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
// Two-pane layout — 800-1023px keeps editor + preview side by side (the
// compile-check loop needs both); the sidebar becomes an overlay drawer
// =================================================================

const TwoPaneLayout: Component<
  ShellProps & {
    filesDrawerOpen: boolean;
    setFilesDrawerOpen: (v: boolean) => void;
  }
> = (props) => {
  const showDrawer = () => consolePosition() === "drawer";

  // Same persisted fraction as DesktopLayout (workspace.centerSplit), so
  // resizing across the 1024px boundary keeps the editor/preview ratio.
  const splitSizes = () => [centerSplit(), 1 - centerSplit()];
  const onSplitSizesChange = (next: number[]) => {
    if (next[0] === undefined || next[0] <= 0) return;
    setCenterSplit(Math.round(next[0] * 1000) / 1000);
  };

  const editorPane = () => (
    <CenterPane
      onSave={props.onSave}
      onCompile={props.onCompile}
      onEditorChange={props.onEditorChange}
      // In the strip row, not a floating overlay — an absolute toggle sat on
      // top of the first file tab and blocked its clicks.
      stripLeading={
        <IconButton
          label="Project files"
          touchTarget
          data-files-toggle
          onClick={() => props.setFilesDrawerOpen(true)}
        >
          <Files size={touchAffordances() ? 16 : 13} />
        </IconButton>
      }
    />
  );

  return (
    <div
      class="relative flex h-full w-full flex-col overflow-hidden"
      data-editor-shell
    >
      {/* Same modal contract as the tablet LogsSheet: while the files drawer
          is up, everything behind the scrim leaves the tab order. The strip
          toggle lives inside this wrapper so it goes inert too — it is the
          drawer's focus-restore target once inert lifts on close. */}
      <div
        class="flex min-h-0 flex-1 flex-col gap-2"
        aria-hidden={props.filesDrawerOpen}
        inert={props.filesDrawerOpen}
      >
        {/* This tier exists so editor + preview stay visible together — the
            desktop editorLayout preference deliberately doesn't collapse
            panes here. A detached preview window still collapses the in-pane
            copy (it is showing elsewhere). */}
        <Switch>
          <Match when={!previewDetached()}>
            <Resizable
              orientation="horizontal"
              class="flex min-h-0 flex-1 overflow-hidden"
              sizes={splitSizes()}
              onSizesChange={onSplitSizesChange}
            >
              <Resizable.Panel minSize={0.3}>
                {editorPane()}
              </Resizable.Panel>
              <Resizable.Handle
                aria-label="Resize preview"
                class="group relative w-[6px] shrink-0"
              >
                <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
              </Resizable.Handle>
              <Resizable.Panel minSize="320px">
                <PreviewPane
                  previewKind={props.previewKind}
                  pdfPath={props.pdfPath}
                  mdBaseDir={props.mdBaseDir}
                  mdTheme={props.mdTheme}
                  onCompile={props.onCompile}
                />
              </Resizable.Panel>
            </Resizable>
          </Match>
          <Match when={previewDetached()}>
            <div class="min-h-0 flex-1">{editorPane()}</div>
          </Match>
        </Switch>

        <Show when={showDrawer() && !focusMode()}>
          <LogsDrawer />
        </Show>

      </div>

      <FilesDrawer
        open={props.filesDrawerOpen}
        onClose={() => props.setFilesDrawerOpen(false)}
        leftTab={props.leftTab}
        setLeftTab={props.setLeftTab}
        outlineCollapsed={props.outlineCollapsed}
        setOutlineCollapsed={props.setOutlineCollapsed}
        onSelectFile={props.onSelectFile}
      />
    </div>
  );
};

// =================================================================
// FilesDrawer — left overlay variant of the docked sidebar for the
// two-pane tier (same modal shape as LogsSheet below)
// =================================================================

const FilesDrawer: Component<{
  open: boolean;
  onClose: () => void;
  leftTab: LeftTab;
  setLeftTab: (t: LeftTab) => void;
  outlineCollapsed: boolean;
  setOutlineCollapsed: (fn: (v: boolean) => boolean) => void;
  onSelectFile: (relPath: string) => void;
}> = (props) => {
  let drawerRef: HTMLDivElement | undefined;
  // Escape closes the drawer for keyboard users.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && props.open) {
      e.stopPropagation();
      props.onClose();
    }
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  // Modal focus contract copied from LogsSheet: focus the first sidebar tab
  // on open; on close, hand focus back to the floating toggle (looked up by
  // its aria-label; the drawer and the toggle live in different components) —
  // but only when focus is loose, so an outside tap that focused something
  // else keeps its target.
  let wasOpen = false;
  createEffect(() => {
    if (!props.open) {
      if (wasOpen) {
        const active = document.activeElement;
        const focusIsLoose =
          active === document.body ||
          active === null ||
          (drawerRef instanceof HTMLElement && drawerRef.contains(active));
        if (focusIsLoose) {
          // Stable hook rather than the accessible name (same rationale as
          // the logs toggle).
          document
            .querySelector<HTMLElement>("[data-files-toggle]")
            ?.focus();
        }
      }
      wasOpen = false;
      return;
    }
    wasOpen = true;
    requestAnimationFrame(() => {
      drawerRef?.querySelector<HTMLElement>('[role="tab"]')?.focus();
    });
  });
  return (
    <Show when={props.open}>
      {/* Backdrop dims the panes behind the drawer; tapping closes it. */}
      <button
        type="button"
        aria-label="Close project files"
        onClick={() => props.onClose()}
        class="absolute inset-0 z-30 bg-[var(--color-overlay-scrim)] backdrop-blur-[1px]"
      />
      <div
        ref={drawerRef}
        class="absolute inset-y-2 left-2 z-40 flex w-[300px] max-w-[75vw] flex-col overflow-hidden"
        role="dialog"
        aria-modal="true"
        aria-label="Project files"
      >
        <EditorSidebar
          tab={props.leftTab}
          setTab={props.setLeftTab}
          outlineCollapsed={props.outlineCollapsed}
          setOutlineCollapsed={props.setOutlineCollapsed}
          onSelectFile={props.onSelectFile}
        />
      </div>
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
      <div
        class="min-h-0 flex-1 px-2"
        aria-hidden={logsSheetOpen()}
        // The LogsSheet scrim only dims this pane visually; without inert its
        // editor and buttons would stay in the tab order behind the modal
        // overlay (aria-hidden + focusable is a WCAG failure).
        inert={logsSheetOpen()}
      >
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

      {/* The sheet is aria-modal, so the switcher must leave the tab order
          with the pane — the focus-restore target (the logs toggle) regains
          focusability before the restore effect runs (inert lifts on close). */}
      <div inert={logsSheetOpen()} aria-hidden={logsSheetOpen()}>
        <PaneSwitcher />
      </div>
      <LogsSheet />
    </div>
  );
};

// =================================================================
// LogsSheet — slide-up overlay variant of LogsDrawer for tablet mode
// =================================================================

const LogsSheet: Component = () => {
  let sheetRef: HTMLDivElement | undefined;
  // Escape closes the sheet for keyboard-attached tablets.
  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape" && logsSheetOpen()) {
      e.stopPropagation();
      setLogsSheetOpen(false);
    }
  };
  document.addEventListener("keydown", onKeyDown);
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));
  // Modal focus contract (same shape as useListboxOpenFocus): move focus to
  // the first log tab once the sheet mounts — without this a keyboard user
  // stays "behind" the dialog. On close, hand focus back to the PaneSwitcher
  // logs toggle (looked up by its aria-label; the sheet and the toggle live
  // in different components) — but only when focus is loose (fell to <body>
  // with the unmount or is still inside the detached sheet), so an outside
  // tap that focused something else keeps its target.
  let wasOpen = false;
  createEffect(() => {
    if (!logsSheetOpen()) {
      if (wasOpen) {
        const active = document.activeElement;
        const focusIsLoose =
          active === document.body ||
          active === null ||
          (sheetRef instanceof HTMLElement && sheetRef.contains(active));
        if (focusIsLoose) {
          // Stable hook, not the aria-label: the label carries a dynamic
          // error count in exactly the compile-failed flow this serves.
          document
            .querySelector<HTMLElement>("[data-logs-toggle]")
            ?.focus();
        }
      }
      wasOpen = false;
      return;
    }
    wasOpen = true;
    requestAnimationFrame(() => {
      sheetRef?.querySelector<HTMLElement>('[role="tab"]')?.focus();
    });
  });
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
        ref={sheetRef}
        class="absolute inset-x-2 bottom-2 z-40 flex max-h-[55vh] flex-col overflow-hidden rounded-xl"
        role="dialog"
        aria-modal="true"
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
  /** Rendered before the tabs in the strip row (the two-pane tier's files
   *  toggle — a floating overlay would sit on top of the first tab). */
  stripLeading?: JSX.Element;
}> = (props) => {
  // Tap-target bumps key on pointer coarseness, not viewport width — a
  // narrow mouse-driven window keeps desktop sizes, a landscape tablet gets
  // the 44px targets.
  const tabHeight = () => (touchAffordances() ? "h-12" : "h-9");
  const tabRowHeight = () => (touchAffordances() ? "h-11" : "h-7");

  // Key the editor on more than the file path: the keyed <Show> reads sessions
  // and the grammar setting untracked, so an LSP handshake that completes after
  // CodeMirror mounts — or a grammar toggle — would otherwise never attach to
  // the open file. Folding session-readiness + grammar state into the key makes
  // the editor remount (and re-run didOpen) exactly when they change. The adopt
  // generation remounts on out-of-editor content replaces (history restore,
  // conflict resolution) — the mounted CM doc is stale by definition then.
  const editorKey = createMemo<string | null>(() => {
    const f = activeFile();
    if (!f?.path) return null;
    const lspLang = lspLanguageForFile(f.relPath);
    const lspReady = lspLang ? !!findSession(lspLang) : false;
    const grammarOn = grammarActive();
    const grammarLang = integrationsSettings().grammar.language ?? "";
    return `${f.path}::a${f.adoptGeneration ?? 0}::${lspReady ? "lsp" : "nolsp"}::${grammarOn ? "g1" : "g0"}::${grammarLang}`;
  });

  // --- Editor view pool -----------------------------------------------------
  // Keep several files' EditorViews mounted at once (display-toggled) so a tab
  // switch to an already-open file never rebuilds CodeMirror's height-map (the
  // ~30ms→~9ms win on a 50k-line file). The reducer logic (one live view per
  // file PATH, FIFO eviction that protects the active view, stable insertion
  // order) lives in editor-pool.ts and is unit-tested there.
  const POOL_LIMIT = 4;
  const [pool, setPool] = createSignal<PoolEntry[]>([]);

  createEffect(() => {
    const key = editorKey();
    const f = activeFile();
    if (!key || !f) return;
    setPool((prev) =>
      withActiveEntry(
        prev,
        { key, path: f.path, relPath: f.relPath },
        POOL_LIMIT,
      ),
    );
  });

  // Drop a view when its file's tab closes (openFiles no longer lists it).
  createEffect(() => {
    const open = new Set(openFiles().map((f) => f.path));
    setPool((prev) => prunePool(prev, open));
  });

  // Closing a dirty buffer silently discards it (the autosave snapshot only
  // resurfaces on the next project open), so any close that drops unsaved work
  // funnels through one confirm. Falls back to window.confirm when the Tauri
  // dialog plugin isn't reachable (dev/webview edge cases).
  const confirmDiscard = async (message: string): Promise<boolean> => {
    try {
      const { ask } = await import("@tauri-apps/plugin-dialog");
      return await ask(message, {
        title: "Unsaved changes",
        kind: "warning",
        okLabel: "Discard changes",
        cancelLabel: "Keep open",
      });
    } catch {
      return window.confirm(message);
    }
  };

  const requestCloseFile = async (index: number) => {
    const f = openFiles()[index];
    if (
      f?.dirty &&
      !(await confirmDiscard(
        `"${f.relPath}" has unsaved changes. Close it and discard them?`,
      ))
    )
      return;
    closeFile(index);
  };

  // Right-click tab-strip actions. Multi-close walks from the highest index
  // down so each closeFile() can't reindex a tab we're about to close.
  const tabMenu = createContextMenuState<number>();

  const closeOtherTabs = async (keepIndex: number) => {
    const files = openFiles();
    if (!files[keepIndex]) return;
    const anyOtherDirty = files.some((f, i) => i !== keepIndex && f.dirty);
    if (
      anyOtherDirty &&
      !(await confirmDiscard(
        "Some of the other tabs have unsaved changes. Close them and discard?",
      ))
    )
      return;
    for (let i = files.length - 1; i >= 0; i--) {
      if (i !== keepIndex) closeFile(i);
    }
  };

  const closeSavedTabs = () => {
    const files = openFiles();
    for (let i = files.length - 1; i >= 0; i--) {
      if (!files[i].dirty) closeFile(i);
    }
  };

  // editor.closeTab / nextTab / prevTab (palette, Mod+W, Ctrl+Tab, macOS File
  // menu) arrive as one-shot intents so close funnels through the same
  // dirty-confirm as the tab strip's own close buttons. Any intent raised
  // while no CenterPane was mounted (preview-only layout, tablet pane
  // switched away) is dropped at mount — honoring it minutes later would
  // close a tab the user no longer means.
  setTabActionIntent(null);
  createEffect(() => {
    const intent = tabActionIntent();
    if (!intent) return;
    setTabActionIntent(null);
    const count = openFiles().length;
    if (count === 0) return;
    if (intent.action === "close") {
      void requestCloseFile(activeIndex());
    } else {
      const delta = intent.action === "next" ? 1 : -1;
      setActiveIndex((activeIndex() + delta + count) % count);
    }
  });

  // Right-click menu over the editor surface. Only opens when the click landed
  // on CodeMirror's `.cm-content` (App.tsx no longer excludes it from native-
  // menu suppression, so a non-`.cm-content` target falls through to that
  // document-level suppressor rather than the browser menu). Items come from
  // the editor-menu action registry; the payload snapshots the editor context
  // at open time.
  const editorMenu = createContextMenuState<EditorMenuContext>();

  const onEditorContextMenu = (e: MouseEvent) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target?.closest(".cm-content")) return;
    const view = getActiveEditorView();
    const f = activeFile();
    if (!view || !f) return;
    // Keyboard-delivered contextmenu events carry no usable position — anchor
    // at the caret instead of the window corner (menu-position's element-rect
    // fallback would put it at the pane edge, far from the selection).
    const keyboardLike =
      (e.clientX === 0 && e.clientY === 0) || (e.detail === 0 && e.button !== 2);
    if (keyboardLike) {
      const caret = view.coordsAtPos(view.state.selection.main.head);
      if (caret) {
        e.preventDefault();
        editorMenu.openAt(
          new MouseEvent("contextmenu", { clientX: caret.left, clientY: caret.bottom }),
          buildEditorMenuContext(view, f.path, f.relPath),
        );
        return;
      }
    }
    editorMenu.openAt(e, buildEditorMenuContext(view, f.path, f.relPath));
  };

  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      {/* File tabs strip — hidden in focus mode along with the toolbar. */}
      <Show when={!focusMode()}>
      <div class={`flex ${tabHeight()} flex-shrink-0 items-center border-b border-glass-stroke`}>
      <Show when={props.stripLeading}>
        {/* Leading slot sits OUTSIDE the tablist (a non-tab inside role=
            tablist would break the pattern) but inside the strip row so it
            occupies real layout space instead of overlaying the first tab. */}
        <div class="flex flex-shrink-0 items-center border-r border-glass-stroke px-1.5">
          {props.stripLeading}
        </div>
      </Show>
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
        class="flex h-full min-w-0 flex-1 items-center gap-0.5 overflow-x-auto px-2 scroll"
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
                  // The dirty marker is a color-only dot — the accname must
                  // carry the unsaved state for screen readers (WCAG 1.4.1).
                  aria-label={
                    f().dirty ? `${f().relPath}, unsaved changes` : f().relPath
                  }
                  tabIndex={active() ? 0 : -1}
                  onClick={() => setActiveIndex(i)}
                  onContextMenu={(e) => tabMenu.openAt(anchoredMenuEvent(e), i)}
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
                      touchAffordances() ? "h-11 w-11" : "h-6 w-6"
                    }`}
                    aria-label={`Close ${f().relPath}`}
                  >
                    <XIcon size={touchAffordances() ? 16 : 12} />
                  </button>
                </div>
              );
            }}
          </Index>
        </Show>
        {/* Save + Compile buttons were removed 2026-05-15. Save is on Mod+S;
            Compile is the PDF panel's Recompile button. */}
      </div>
      </div>
      </Show>

      <Show when={activeFile() && !focusMode()}>
        <FormatToolbar />
      </Show>

      <div
        class="min-h-0 flex-1 overflow-hidden"
        onContextMenu={onEditorContextMenu}
      >
        <Show
          when={pool().length > 0}
          fallback={
            <div class="flex h-full items-center justify-center text-sm text-fg-3">
              Open a file from the sidebar.
            </div>
          }
        >
          <div class="relative h-full w-full">
            <For each={pool()}>
              {(entry) => {
                const lang = languageForFile(entry.relPath);
                const lspLang = lspLanguageForFile(entry.relPath);
                const lspSession = lspLang ? findSession(lspLang) : undefined;
                const extras = lspSession
                  ? lspSession.document({
                      uri: pathToFileUri(entry.path),
                      languageId: lang,
                    }) ?? []
                  : [];
                const extrasList = Array.isArray(extras) ? extras : [extras];
                // Local \ref/\cite completion from the project index. When
                // texlab owns the editor it composes the source into its own
                // override (cm6.ts); here it covers the texlab-absent case.
                if (lang === "latex" && !lspSession) {
                  extrasList.push(refCiteCompletionExtension());
                  // Undefined-reference + duplicate-label warnings; only when
                  // texlab is absent — it ships its own.
                  extrasList.push(refDiagnosticsExtension(entry.relPath));
                }
                // Go-to-definition for \ref/\cite from the project index — works
                // with or without texlab, reaches labels in other chapter files.
                if (lang === "latex") {
                  extrasList.push(refCiteGotoExtension(entry.relPath));
                }
                // Read once per pooled view: a grammar toggle / LSP attach mints
                // a new editorKey, so a fresh entry (with fresh extras) replaces
                // this one — computing at entry creation is correct.
                const grammarExt = grammarActive()
                  ? [
                      harperLinter({
                        syntax: grammarSyntaxForLanguage(lang),
                        file: entry.relPath,
                        dialect: asGrammarDialect(
                          integrationsSettings().grammar.language,
                        ),
                      }),
                    ]
                  : [];
                const reviewExt = reviewExtension({
                  // Bound to THIS pooled view's own file — several views are
                  // live, so a background debounced flush must touch only its
                  // own file's threads.
                  onOffsetsChanged: (updates) =>
                    updateThreadOffsets(
                      entry.relPath,
                      updates.map((u) => ({
                        id: u.id,
                        fromOffset: u.from,
                        toOffset: u.to,
                        anchorText: u.anchorText,
                      })),
                    ),
                  onGutterClick: (threadId: string) =>
                    requestThreadPanel(threadId),
                });
                const isActive = () => entry.key === editorKey();
                // This entry's OWN live content (a memo, so a keystroke in the
                // active file doesn't re-run every pooled view's review effect).
                const fileContent = createMemo(
                  () =>
                    openFiles().find((of) => of.path === entry.path)?.content ??
                    "",
                );
                const [reviewView, setReviewView] =
                  createSignal<EditorView | null>(null);
                // The review store is the single source of truth for anchors;
                // the CM decorations are derived. Seed on ready and re-derive on
                // any store change so the gutter never shows a stale state.
                createEffect(() => {
                  const v = reviewView();
                  const threads = allThreads();
                  if (!v) return;
                  syncThreadsToView(v, threads, entry.relPath, fileContent());
                });
                const visualOn = () =>
                  editorSettings().visualModeLatex &&
                  isVisualEligibleFile(entry.relPath) &&
                  !visualPaused(entry.relPath);
                // A fast-path reveal (an already-built view shown again) fires no
                // onReady, so stamp the tab-switch measure when this entry
                // becomes active. perfMeasure dedups per mark instance.
                createEffect(
                  on(
                    isActive,
                    (active) => {
                      if (active && reviewView()) {
                        perfMeasure(
                          "tab-switch-to-editor",
                          "tab-switch",
                          entry.relPath,
                        );
                      }
                    },
                    { defer: true },
                  ),
                );
                return (
                  <div
                    class="absolute inset-0"
                    style={{ display: isActive() ? undefined : "none" }}
                  >
                    <CodeMirror
                      value={fileContent()}
                      active={isActive()}
                      onChange={(text) =>
                        updateFileContentByPath(entry.path, text)
                      }
                      language={lang}
                      fontSize={editorSettings().fontSize}
                      lineHeight={LINE_HEIGHT_VALUES[editorSettings().lineHeight]}
                      lineWrap={visualOn() || editorSettings().lineWrap}
                      lineNumbers={!visualOn() && editorSettings().lineNumbers}
                      highlightActiveLine={
                        !visualOn() && editorSettings().highlightActiveLine
                      }
                      autocomplete={editorSettings().autocomplete}
                      bracketMatching={editorSettings().bracketMatching}
                      autoCloseBrackets={editorSettings().autoCloseBrackets}
                      tabSize={editorSettings().tabSize}
                      vimMode={editorSettings().vimMode}
                      visualMode={visualOn()}
                      onVisualPause={() => markVisualPaused(entry.relPath)}
                      onVisualPopover={requestVisualPopover}
                      visualResolveAsset={(rel) => {
                        // \includegraphics paths resolve against the project
                        // root (the compiler's working directory).
                        const root = entry.path.slice(
                          0,
                          Math.max(0, entry.path.length - entry.relPath.length),
                        );
                        return resolveProjectAsset(root, rel);
                      }}
                      lspActive={!!lspSession}
                      stashKey={entry.path}
                      onReady={(v) => {
                        setReviewView(v);
                        perfMeasure(
                          "tab-switch-to-editor",
                          "tab-switch",
                          entry.relPath,
                        );
                        perfMeasure(
                          "open-to-editor",
                          "project-open",
                          entry.relPath,
                          60_000,
                        );
                      }}
                      extraExtensions={[
                        ...extrasList,
                        ...grammarExt,
                        ...reviewExt,
                      ]}
                    />
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>

      <Show when={!focusMode()}>
        <StatusBar />
      </Show>

      {/* The visual-mode edit popover — the one surface where LaTeX source
          is meant to appear while visual editing. */}
      <Show when={visualPopoverIntent()}>
        <VisualPopover />
      </Show>

      {/* Compose popover for editor-anchored review comments/TODOs — gates
          itself on its own intent signal. */}
      <ReviewComposePopover />

      <Show when={tabMenu.menu()}>
        {(m) => (
          <ContextMenu x={m().x} y={m().y} onClose={tabMenu.close} widthPx={200}>
            <ContextMenuItem
              icon={XIcon}
              label="Close"
              onClick={() => {
                tabMenu.close();
                void requestCloseFile(m().payload);
              }}
            />
            <ContextMenuItem
              icon={SquareX}
              label="Close others"
              disabled={openFiles().length < 2}
              onClick={() => {
                tabMenu.close();
                void closeOtherTabs(m().payload);
              }}
            />
            <ContextMenuItem
              icon={ListX}
              label="Close saved"
              disabled={!openFiles().some((f) => !f.dirty)}
              onClick={() => {
                tabMenu.close();
                closeSavedTabs();
              }}
            />
          </ContextMenu>
        )}
      </Show>

      <Show when={editorMenu.menu()}>
        {(m) => (
          <EditorContextMenu
            x={m().x}
            y={m().y}
            ctx={m().payload}
            onClose={editorMenu.close}
          />
        )}
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
      <Show when={project()?.format === "latex"}>
        <span class="opacity-50">·</span>
        <BuildMenu />
      </Show>
      <span class="ml-auto flex items-center gap-3">
        <GrammarProblemsIndicator />
        <CompileIndicator />
      </span>
    </div>
  );
};

const GrammarProblemsIndicator: Component = () => {
  const enabled = () => grammarActive();
  const count = () => grammarTotalCount();
  const onClick = () => {
    if (consolePosition() === "pdf-tab") {
      setPreviewMode("console");
      queueMicrotask(() => requestLogsTab("grammar"));
    } else {
      requestLogsTab("grammar");
    }
  };
  return (
    <Show when={enabled() && count() > 0}>
      <button
        type="button"
        onClick={onClick}
        title="Show grammar problems"
        class="lift inline-flex items-center gap-1.5 text-fg-3 hover:text-fg-2"
      >
        <span
          class="h-1.5 w-1.5 rounded-full"
          style={{ background: "var(--color-warn)" }}
        />
        <SpellCheck size={12} />
        {count()} problem{count() === 1 ? "" : "s"}
      </button>
    </Show>
  );
};

const CompileIndicator: Component = () => {
  // Error → jump to the Errors console (same intent as the grammar indicator
  // above); otherwise re-run the compile — the orchestrator's compiling-guard
  // absorbs clicks while a build is already running.
  const onClick = () => {
    if (compileState() === "error") revealCompileErrors();
    else void compileActiveProject();
  };
  return (
    <Show when={lastResult()}>
      <button
        type="button"
        onClick={onClick}
        title={
          compileState() === "error" ? "Show compile errors" : "Compile project"
        }
        // Content alone would name this "842ms, button" — state and action
        // live in icon + color, which screen readers can't see.
        aria-label={
          compileState() === "error"
            ? "Compile failed — show errors"
            : compileState() === "compiling"
              ? "Compiling"
              : `Compiled in ${lastResult()!.durationMs}ms — recompile`
        }
        class={`lift inline-flex items-center gap-1 ${
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
      </button>
    </Show>
  );
};
