import Resizable from "corvu/resizable";
import {
  CheckCircle2,
  Loader2,
  X as XIcon,
  XCircle,
} from "lucide-solid";
import type { Component } from "solid-js";
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { CodeMirror } from "~/components/editor/CodeMirror";
import {
  EditorSidebar,
  type LeftTab,
} from "~/components/editor/EditorSidebar";
import { FormatToolbar } from "~/components/editor/FormatToolbar";
import { LogsDrawer } from "~/components/editor/LogsDrawer";
import { PaneSwitcher } from "~/components/layout/PaneSwitcher";
import { PdfViewer } from "~/components/pdf/PdfViewer";
import {
  activeFile,
  activeIndex,
  closeFile,
  compileState,
  lastResult,
  openFiles,
  pdfScrollTarget,
  pdfVersion,
  setActiveIndex,
  updateActiveFile,
} from "~/stores/editor-store";
import { cursorCol, cursorLine } from "~/stores/editor-view-store";
import { editorSettings } from "~/stores/settings-store";
import {
  consolePosition,
  editorLayout,
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

  const save = () => void saveActiveFile();
  const compile = () => void compileActiveProject();

  const pdfPath = createMemo(() => lastResult()?.outputPath ?? null);

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
}

// =================================================================
// Desktop layout — three corvu Resizable panes (existing behavior)
// =================================================================

const DesktopLayout: Component<ShellProps> = (props) => {
  const showEditor = () => editorLayout() !== "preview";
  const showPreview = () => editorLayout() !== "editor";
  const showDrawer = () => consolePosition() === "drawer";

  const sidebar = createSidebarResize({ minPx: 200, maxPx: 320, defaultPx: 260 });

  const editorPane = () => (
    <CenterPane
      onSave={props.onSave}
      onCompile={props.onCompile}
      onEditorChange={props.onEditorChange}
    />
  );
  const previewPane = () => (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
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
    </div>
  );

  return (
    <Resizable
      ref={sidebar.setRef}
      orientation="horizontal"
      class="flex h-full w-full overflow-hidden"
      data-editor-shell
      sizes={sidebar.sizes()}
      onSizesChange={sidebar.onSizesChange}
    >
      <Resizable.Panel minSize="200px" maxSize="320px">
        <EditorSidebar
          tab={props.leftTab}
          setTab={props.setLeftTab}
          outlineCollapsed={props.outlineCollapsed}
          setOutlineCollapsed={props.setOutlineCollapsed}
          onSelectFile={props.onSelectFile}
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
                <Resizable.Panel initialSize={0.45} minSize={0.22}>
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
            <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
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
            </div>
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
  return (
    <Show when={logsSheetOpen()}>
      {/* Backdrop dims the pane behind the sheet; tapping closes it. */}
      <button
        type="button"
        aria-label="Close logs"
        onClick={() => setLogsSheetOpen(false)}
        class="absolute inset-0 z-30 bg-black/40 backdrop-blur-[1px]"
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

  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      {/* File tabs strip */}
      <div
        class={`flex ${tabHeight()} flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-glass-stroke px-2 scroll`}
      >
        <Show
          when={openFiles().length > 0}
          fallback={
            <span class="px-2 text-[12px] text-fg-3">No file open</span>
          }
        >
          <For each={openFiles()}>
            {(f, i) => {
              const active = () => activeIndex() === i();
              return (
                <div
                  class={`lift flex ${tabRowHeight()} flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium ${
                    active() ? "text-fg-1" : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                  }`}
                  style={
                    active()
                      ? {
                          background: "var(--color-control-fill)",
                          border: "1px solid rgba(139,92,246,0.25)",
                        }
                      : undefined
                  }
                >
                  <button
                    type="button"
                    onClick={() => setActiveIndex(i())}
                    class="mono"
                  >
                    {f.relPath}
                  </button>
                  <Show when={f.dirty}>
                    <span
                      class="h-1.5 w-1.5 rounded-full"
                      style={{ background: "var(--color-accent-1)" }}
                    />
                  </Show>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      closeFile(i());
                    }}
                    class={`-mr-1 flex items-center justify-center rounded opacity-60 hover:bg-[var(--color-control-fill-hover)] hover:opacity-100 ${
                      isTabletViewport() ? "h-9 w-9" : "h-4 w-4"
                    }`}
                    aria-label={`Close ${f.relPath}`}
                  >
                    <XIcon size={isTabletViewport() ? 16 : 10} />
                  </button>
                </div>
              );
            }}
          </For>
        </Show>
        {/* Save + Compile buttons were removed 2026-05-15. Save is on Mod+S;
            Compile is the PDF panel's Recompile button. */}
      </div>

      <Show when={activeFile()}>
        <FormatToolbar />
      </Show>

      <div class="min-h-0 flex-1 overflow-hidden">
        <Show
          when={activeFile()?.path}
          keyed
          fallback={
            <div class="flex h-full items-center justify-center text-[12px] text-fg-3">
              Open a file from the sidebar.
            </div>
          }
        >
          {(_path) => {
            const f = activeFile()!;
            const lang = languageFor(f.relPath);
            const lspLang = languageToLspLanguage(lang);
            const extras = lspLang
              ? findSession(lspLang)?.document({
                  uri: pathToFileUri(f.path),
                  languageId: lang,
                }) ?? []
              : [];
            return (
              <CodeMirror
                value={f.content}
                onChange={props.onEditorChange}
                language={lang}
                fontSize={editorSettings().fontSize}
                lineWrap={editorSettings().lineWrap}
                extraExtensions={Array.isArray(extras) ? extras : [extras]}
              />
            );
          }}
        </Show>
      </div>

      <StatusBar />
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
    <div class="mono flex h-6 flex-shrink-0 items-center gap-3 border-t border-glass-stroke px-3 text-[11px] text-fg-3">
      <Show when={file()}>
        <Show when={lnCol()} fallback={<span class="opacity-60">Ln —, Col —</span>}>
          <span>{lnCol()}</span>
        </Show>
        <span class="opacity-50">·</span>
        <span class="capitalize">{languageFor(file()!.relPath)}</span>
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

function languageFor(
  relPath: string,
): "latex" | "markdown" | "typst" | "plain" {
  const lower = relPath.toLowerCase();
  if (lower.endsWith(".tex") || lower.endsWith(".bib")) return "latex";
  if (lower.endsWith(".typ")) return "typst";
  if (lower.endsWith(".md") || lower.endsWith(".rmd")) return "markdown";
  return "plain";
}

function languageToLspLanguage(
  lang: "latex" | "markdown" | "typst" | "plain",
): "latex" | "markdown" | "typst" | null {
  if (lang === "latex") return "latex";
  if (lang === "markdown") return "markdown";
  if (lang === "typst") return "typst";
  return null;
}
