import Resizable from "corvu/resizable";
import {
  BookOpen,
  CheckCircle2,
  FileQuestion,
  Loader2,
  Play,
  PlayCircle,
  RotateCcw,
  Save,
  X as XIcon,
  XCircle,
} from "lucide-solid";
import type { Component } from "solid-js";
import { For, Match, Show, Switch, createMemo, createSignal, onCleanup, onMount } from "solid-js";
import { Cell as CellView } from "~/components/notebook/Cell";
import { CellOutput } from "~/components/notebook/CellOutput";
import { EditorSidebar, type LeftTab } from "~/components/editor/EditorSidebar";
import { LogsDrawer } from "~/components/editor/LogsDrawer";
import { PaneSwitcher } from "~/components/layout/PaneSwitcher";
import { PdfViewer } from "~/components/pdf/PdfViewer";
import { Button } from "~/components/primitives/Button";
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
} from "~/stores/editor-store";
import {
  activeCellId,
  addCellAfter,
  cells,
} from "~/stores/notebook-store";
import {
  outputs,
  restartRKernel,
  runCellById,
  runningIds,
} from "~/stores/notebook-outputs-store";
import { blankCodeCell } from "~/lib/notebook/parser";
import {
  compileActiveProject,
  saveActiveFile,
  syncInverseFromPdfClick,
} from "~/commands/actions";
import {
  activePane,
  cyclePane,
  isTabletViewport,
  logsSheetOpen,
  setActivePane,
  setLogsSheetOpen,
} from "~/stores/viewport-store";
import { installSwipeListener } from "~/lib/gestures";
import { createSidebarResize } from "~/lib/sidebar-resize";

/**
 * Notebook shell — same three-pane geometry as TextShell (sidebar / cells /
 * preview + bottom log drawer), but the center column renders cells via
 * `notebook-store` instead of a single CodeMirror buffer.
 *
 * When the active file isn't an .Rmd (e.g. user opens an auxiliary
 * .R file from the tree), we show a placeholder rather than degrading
 * silently — the cells store would be empty and that's confusing. The
 * "Open main" affordance routes them back.
 */
export const NotebookShell: Component<{
  onSelectFile: (relPath: string) => void;
}> = (props) => {
  const [leftTab, setLeftTab] = createSignal<LeftTab>("files");
  const [outlineCollapsed, setOutlineCollapsed] = createSignal(false);

  const save = () => void saveActiveFile();
  const render = () => void compileActiveProject();

  const pdfPath = createMemo(() => lastResult()?.outputPath ?? null);

  const isNotebookFile = (relPath: string | undefined): boolean => {
    if (!relPath) return false;
    return relPath.toLowerCase().endsWith(".rmd");
  };

  const handleSelectFile = (rel: string) => {
    props.onSelectFile(rel);
    if (isTabletViewport()) setActivePane("editor");
  };

  return (
    <Show
      when={!isTabletViewport()}
      fallback={
        <NotebookTabletLayout
          leftTab={leftTab()}
          setLeftTab={setLeftTab}
          outlineCollapsed={outlineCollapsed()}
          setOutlineCollapsed={setOutlineCollapsed}
          onSelectFile={handleSelectFile}
          onSave={save}
          onRender={render}
          isNotebookFile={isNotebookFile}
          pdfPath={pdfPath()}
        />
      }
    >
      <NotebookDesktopLayout
        leftTab={leftTab()}
        setLeftTab={setLeftTab}
        outlineCollapsed={outlineCollapsed()}
        setOutlineCollapsed={setOutlineCollapsed}
        onSelectFile={handleSelectFile}
        onSave={save}
        onRender={render}
        isNotebookFile={isNotebookFile}
        pdfPath={pdfPath()}
      />
    </Show>
  );
};

interface NotebookShellProps {
  leftTab: LeftTab;
  setLeftTab: (t: LeftTab) => void;
  outlineCollapsed: boolean;
  setOutlineCollapsed: (fn: (v: boolean) => boolean) => void;
  onSelectFile: (relPath: string) => void;
  onSave: () => void;
  onRender: () => void;
  isNotebookFile: (relPath: string | undefined) => boolean;
  pdfPath: string | null;
}

const NotebookDesktopLayout: Component<NotebookShellProps> = (props) => {
  const sidebar = createSidebarResize({ minPx: 200, maxPx: 320, defaultPx: 260 });

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
          <Resizable
            orientation="horizontal"
            class="flex min-h-0 flex-1 overflow-hidden"
          >
            <Resizable.Panel initialSize={0.55} minSize={0.3}>
              <CellsPane
                onSave={props.onSave}
                onRender={props.onRender}
                onSelectFile={props.onSelectFile}
                isNotebookFile={props.isNotebookFile}
              />
            </Resizable.Panel>

            <Resizable.Handle
              aria-label="Resize preview"
              class="group relative w-[6px] shrink-0"
            >
              <div class="absolute inset-y-2 left-1 right-1 rounded-sm transition group-hover:bg-[linear-gradient(180deg,var(--color-accent-1),var(--color-accent-2))] group-hover:opacity-70" />
            </Resizable.Handle>

            <Resizable.Panel initialSize={0.45} minSize={0.22}>
              <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
                <PdfViewer
                  path={props.pdfPath}
                  version={pdfVersion()}
                  onCompile={props.onRender}
                  compiling={compileState() === "compiling"}
                  scrollTarget={pdfScrollTarget()}
                  onPageClick={(page, x, y) => {
                    void syncInverseFromPdfClick(page, x, y);
                  }}
                />
              </div>
            </Resizable.Panel>
          </Resizable>

          <LogsDrawer />
        </div>
      </Resizable.Panel>
    </Resizable>
  );
};

const NotebookTabletLayout: Component<NotebookShellProps> = (props) => {
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
            <CellsPane
              onSave={props.onSave}
              onRender={props.onRender}
              onSelectFile={props.onSelectFile}
              isNotebookFile={props.isNotebookFile}
            />
          </Match>
          <Match when={activePane() === "preview"}>
            <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
              <PdfViewer
                path={props.pdfPath}
                version={pdfVersion()}
                onCompile={props.onRender}
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

      <Show when={logsSheetOpen()}>
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
    </div>
  );
};

const CellsPane: Component<{
  onSave: () => void;
  onRender: () => void;
  onSelectFile: (relPath: string) => void;
  isNotebookFile: (relPath: string | undefined) => boolean;
}> = (props) => {
  return (
    <div class="glass flex h-full flex-col overflow-hidden rounded-xl">
      <FileTabsStrip onSave={props.onSave} onRender={props.onRender} />
      <NotebookModeBanner />
      <div class="min-h-0 flex-1 overflow-auto scroll px-3 pb-6 pt-2">
        <Show
          when={props.isNotebookFile(activeFile()?.relPath)}
          fallback={<NonNotebookPlaceholder onOpenMain={props.onSelectFile} />}
        >
          <CellList />
        </Show>
      </div>
      <NotebookStatusBar />
    </div>
  );
};

const FileTabsStrip: Component<{
  onSave: () => void;
  onRender: () => void;
}> = (props) => (
  <div class="flex h-9 flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-glass-stroke px-2 scroll">
    <Show
      when={openFiles().length > 0}
      fallback={<span class="px-2 text-[12px] text-fg-3">No file open</span>}
    >
      <For each={openFiles()}>
        {(f, i) => {
          const active = () => activeIndex() === i();
          return (
            <div
              class={`lift flex h-7 flex-shrink-0 items-center gap-1.5 rounded-md px-2.5 text-[12px] font-medium ${
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
                class="-mr-1 flex h-4 w-4 items-center justify-center rounded opacity-60 hover:bg-[var(--color-control-fill-hover)] hover:opacity-100"
                aria-label={`Close ${f.relPath}`}
              >
                <XIcon size={10} />
              </button>
            </div>
          );
        }}
      </For>
    </Show>
    <div class="ml-auto flex items-center gap-1 pl-2">
      <Button
        variant="ghost"
        size="sm"
        onClick={props.onSave}
        disabled={!activeFile()?.dirty}
        leadingIcon={<Save size={12} />}
      >
        Save
      </Button>
      <Button
        variant="primary"
        size="sm"
        onClick={props.onRender}
        disabled={compileState() === "compiling" || !project()}
        leadingIcon={
          compileState() === "compiling" ? (
            <Loader2 size={12} class="animate-spin" />
          ) : (
            <PlayCircle size={12} />
          )
        }
      >
        Render
      </Button>
    </div>
  </div>
);

const NotebookModeBanner: Component = () => {
  const label = () => {
    const p = project();
    if (p?.format === "rmarkdown") return "R Markdown";
    return "Notebook";
  };
  const busy = () => runningIds().size > 0;
  return (
    <div class="glass-soft mx-2 mt-2 flex h-7 flex-shrink-0 items-center gap-2 rounded-md px-2.5">
      <BookOpen size={11} style={{ color: "var(--color-accent-1)" }} />
      <span class="label-xs" style={{ color: "var(--color-accent-1)" }}>
        Notebook
      </span>
      <span class="mono text-[10px] text-fg-3">·</span>
      <span class="text-[11px] text-fg-2">{label()}</span>
      <span class="ml-auto flex items-center gap-2">
        <span class="mono text-[10px] text-fg-3">
          R kernel: {busy() ? "busy" : "idle"}
        </span>
        <button
          type="button"
          onClick={() => void restartRKernel()}
          disabled={busy()}
          class="lift flex h-5 items-center gap-1 rounded px-1.5 text-[10px] text-fg-2 hover:bg-[var(--color-control-fill-hover)] disabled:opacity-40"
          aria-label="Restart R kernel"
          title="Restart R kernel (clears variables)"
        >
          <RotateCcw size={10} />
          Restart
        </button>
      </span>
    </div>
  );
};

const CellList: Component = () => (
  <div class="mx-auto flex max-w-[820px] flex-col gap-1">
    <For each={cells()}>
      {(cell, idx) => {
        const result = () => outputs()[cell.id];
        return (
          <CellView
            cell={cell}
            index={idx()}
            total={cells().length}
            onAddBelow={() => addCellAfter(cell.id, blankCodeCell("r"))}
            onRun={(id) => void runCellById(id)}
            running={runningIds().has(cell.id)}
            output={
              result() ? <CellOutput result={result()!} /> : undefined
            }
          />
        );
      }}
    </For>
    <Show when={cells().length === 0}>
      <div class="py-12 text-center text-[12px] text-fg-3">
        Parsing notebook…
      </div>
    </Show>
  </div>
);

const NonNotebookPlaceholder: Component<{
  onOpenMain: (relPath: string) => void;
}> = (props) => {
  const p = () => project();
  return (
    <div class="flex h-full items-center justify-center">
      <div class="glass-soft flex max-w-[420px] flex-col items-center gap-2.5 rounded-xl p-6 text-center">
        <div
          class="flex h-10 w-10 items-center justify-center rounded-full"
          style={{ background: "var(--color-control-fill)" }}
        >
          <FileQuestion size={18} class="text-fg-3" />
        </div>
        <h2 class="text-[13px] font-semibold text-fg-1">
          Not a notebook source
        </h2>
        <p class="text-[12px] leading-relaxed text-fg-3">
          The notebook shell renders <span class="mono">.Rmd</span> files as
          editable cells. Other files live in the file tree — open them in a
          Text project to edit, or open the project's main notebook below.
        </p>
        <Show when={p()}>
          <button
            type="button"
            onClick={() => props.onOpenMain(p()!.rootFile)}
            class="lift glow-violet mt-1 flex h-7 items-center gap-1.5 rounded-md accent-grad px-3 text-[12px] font-semibold text-white"
          >
            <Play size={11} stroke-width={2.4} />
            Open {p()!.rootFile}
          </button>
        </Show>
      </div>
    </div>
  );
};

const NotebookStatusBar: Component = () => (
  <div class="mono flex h-6 flex-shrink-0 items-center gap-3 border-t border-glass-stroke px-3 text-[11px] text-fg-3">
    <Show when={activeFile()}>
      <span>{cells().length} cells</span>
      <Show when={activeCellId()}>
        <span class="opacity-50">·</span>
        <span>active: {activeCellId()}</span>
      </Show>
      <span class="opacity-50">·</span>
      <span>UTF-8</span>
    </Show>
    <span class="ml-auto flex items-center gap-1.5">
      <CompileIndicator />
    </span>
  </div>
);

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
