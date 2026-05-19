import { useNavigate, useSearchParams } from "@solidjs/router";
import {
  FileQuestion,
  Folder,
  History,
  Settings as SettingsIcon,
  Users,
} from "lucide-solid";
import { LayoutMenu } from "~/components/editor/LayoutMenu";
import { ProjectSwitcherMenu } from "~/components/editor/ProjectSwitcherMenu";
import type { Component } from "solid-js";
import { Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { Glass } from "~/components/glass/Glass";
import { Button } from "~/components/primitives/Button";
import { RecoveryDialog } from "~/components/editor/RecoveryDialog";
import * as ipc from "~/ipc";
import {
  activeFile,
  compileState,
  gotoSourceIntent,
  lastResult,
  openFile as openFileInStore,
  project,
  resetTabs,
  setProject,
} from "~/stores/editor-store";
import { setCursorLine } from "~/stores/editor-view-store";
import { setPreviousRoute } from "~/stores/nav-store";
import { startSession, stopAllSessions } from "~/stores/lsp-store";
import { startWatching, stopWatching } from "~/stores/watcher-store";
import { TextShell } from "./shells/text-shell";
import { NotebookShell } from "./shells/notebook-shell";
import { createAsyncGenerationGuard } from "~/lib/async-generation";
import { LatexAdapter } from "~/adapters/latex/LatexAdapter";
import { MarkdownAdapter } from "~/adapters/markdown/MarkdownAdapter";
import { RmarkdownAdapter } from "~/adapters/rmarkdown/RmarkdownAdapter";
import { TypstAdapter } from "~/adapters/typst/TypstAdapter";
import {
  registerAdapterCommands,
  unregisterAdapterCommands,
} from "~/commands/boot";
import type { EditorAdapter } from "~/adapters/types";

const adapterForFormat = (
  format: string,
): EditorAdapter | null => {
  if (format === "latex") return LatexAdapter;
  if (format === "markdown") return MarkdownAdapter;
  if (format === "typst") return TypstAdapter;
  if (format === "rmarkdown") return RmarkdownAdapter;
  return null;
};

const EditorScreen: Component = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [orphans, setOrphans] = createSignal<ipc.Snapshot[]>([]);
  const [recoveryOpen, setRecoveryOpen] = createSignal(false);
  const loadGuard = createAsyncGenerationGuard();

  let registeredAdapter: EditorAdapter | null = null;

  const teardownAdapter = () => {
    if (registeredAdapter) {
      unregisterAdapterCommands(registeredAdapter);
      registeredAdapter = null;
    }
  };

  createEffect(() => {
    const token = loadGuard.next();
    const path = typeof params.path === "string" ? params.path : null;
    if (!path) {
      void stopAllSessions();
      void stopWatching();
      teardownAdapter();
      setProject(null);
      resetTabs();
      return;
    }
    void (async () => {
      try {
        const p = await ipc.openProject(path);
        if (!token.isCurrent()) return;
        // Tear down any previous project's LSP sessions + watcher before swapping.
        await stopAllSessions();
        await stopWatching();
        if (!token.isCurrent()) return;
        teardownAdapter();
        setProject(p);
        resetTabs();
        // Bind the matching adapter's commands into the registry so the
        // palette and Mod+Enter work format-specifically. Adapters without
        // an impl yet (R Markdown only one remaining) are a no-op.
        const adapter = adapterForFormat(p.format);
        if (adapter) {
          registerAdapterCommands(adapter);
          registeredAdapter = adapter;
        }
        // Start the file watcher so external edits / new files / deletions
        // refresh the FileTree (it reads `fsVersion` as a resource source).
        void startWatching(p.rootPath, token.isCurrent);
        try {
          const found = await ipc.listOrphanSnapshots(p.rootPath);
          if (!token.isCurrent()) return;
          if (found.length > 0) {
            setOrphans(found);
            setRecoveryOpen(true);
          }
        } catch {
          /* recovery best-effort */
        }
        // Start the matching LSP for the project's primary format. Silently
        // no-ops if the binary isn't installed. RMD reuses the markdown LSP
        // (marksman) for basic prose completions — chunk-aware tooling
        // would need a dedicated server, deferred.
        if (p.format === "latex") void startSession("latex", p, token.isCurrent);
        else if (p.format === "typst") void startSession("typst", p, token.isCurrent);
        else if (p.format === "markdown" || p.format === "rmarkdown")
          void startSession("markdown", p, token.isCurrent);
        await openFile(p.rootFile, p, token.isCurrent);
      } catch (e) {
        if (!token.isCurrent()) return;
        console.error("Failed to open project", e);
        setProject(null);
        resetTabs();
      }
    })();
  });

  onCleanup(() => {
    loadGuard.invalidate();
    void stopAllSessions();
    void stopWatching();
    teardownAdapter();
  });

  const openFile = async (
    relPath: string,
    ownerProject: NonNullable<ReturnType<typeof project>> | null = project(),
    isCurrent: () => boolean = () => true,
  ) => {
    const p = ownerProject;
    if (!p) return;
    const abs = joinPath(p.rootPath, relPath);
    try {
      const content = await ipc.readProjectTextFile(p.rootPath, relPath);
      if (!isCurrent()) return;
      openFileInStore({ path: abs, relPath, content, dirty: false });
    } catch (e) {
      console.error("Failed to read file", abs, e);
    }
  };

  // Inverse-search intent: open the requested file (if needed) and move
  // the cursor to the target line. We watch BOTH the intent and the
  // active file — when the active file finally matches the intent's
  // relPath, the cursor gets dispatched. The generation field prevents
  // re-firing after we've handled an intent.
  let lastHandledGeneration = 0;
  let pendingIntentRelPath: string | null = null;
  let pendingIntentLine = 0;

  createEffect(() => {
    const intent = gotoSourceIntent();
    if (!intent) return;
    if (intent.generation <= lastHandledGeneration) return;
    // Capture intent details for the follow-up active-file effect.
    pendingIntentRelPath = intent.relPath;
    pendingIntentLine = intent.line;
    lastHandledGeneration = intent.generation;

    const f = activeFile();
    if (f && f.relPath === intent.relPath) {
      // Already open and active — move the cursor on the next microtask
      // so any pending edits settle first.
      queueMicrotask(() => {
        setCursorLine(intent.line);
        pendingIntentRelPath = null;
      });
    } else {
      void openFile(intent.relPath);
    }
  });

  // When the active file changes, if it matches a pending intent, place
  // the cursor. CodeMirror remounts on file switch, so we wait one
  // microtask to let the new EditorView register itself.
  createEffect(() => {
    const f = activeFile();
    if (!f || !pendingIntentRelPath) return;
    if (f.relPath !== pendingIntentRelPath) return;
    const line = pendingIntentLine;
    queueMicrotask(() => {
      setCursorLine(line);
    });
    pendingIntentRelPath = null;
  });

  const handleRestore = async (snapshots: ipc.Snapshot[]) => {
    const p = project();
    if (!p) return;
    const f = activeFile();
    const target =
      snapshots.find((s) => f && s.relPath === f.relPath) ?? snapshots[0];
    openFileInStore({
      path: joinPath(p.rootPath, target.relPath),
      relPath: target.relPath,
      content: target.content,
      dirty: true,
    });
  };

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />
      <Switch>
        <Match when={!project()}>
          <NoProject onBack={() => navigate("/projects")} />
        </Match>
        <Match when={project()}>
          <div class="relative z-10 flex h-full flex-col">
            <EditorTopBar
              onBack={() => navigate("/projects")}
              onSettings={() => {
                setPreviousRoute("/editor");
                navigate("/settings");
              }}
            />
            <div class="flex min-h-0 flex-1 gap-2 p-2">
              <Show
                when={project()?.experience === "notebook"}
                fallback={<TextShell onSelectFile={(rel) => void openFile(rel)} />}
              >
                <NotebookShell onSelectFile={(rel) => void openFile(rel)} />
              </Show>
            </div>
          </div>
          <RecoveryDialog
            projectRoot={project()!.rootPath}
            open={recoveryOpen()}
            orphans={orphans()}
            onClose={() => setRecoveryOpen(false)}
            onRestore={handleRestore}
          />
        </Match>
      </Switch>
    </div>
  );
};

// =================================================================
// 44px Top bar — ported from design_files/Editor.html (line 6992+)
// =================================================================

const EditorTopBar: Component<{
  onBack: () => void;
  onSettings: () => void;
}> = (props) => {
  const breadcrumb = createMemo(() => {
    const p = project();
    const f = activeFile();
    if (!p) return null;
    return { space: p.name, sub: "sections", file: f?.relPath ?? p.rootFile };
  });

  const saveLabel = createMemo(() => {
    const f = activeFile();
    if (!f) return "—";
    return f.dirty ? "Unsaved" : "Saved";
  });

  const compileLabel = createMemo(() => {
    const s = compileState();
    if (s === "compiling") return "Compiling…";
    if (s === "ok") return "Compiled";
    if (s === "error") return "Error";
    return "Idle";
  });

  const compileDuration = createMemo(() => {
    const r = lastResult();
    return r ? `${(r.durationMs / 1000).toFixed(2)}s` : "—";
  });

  return (
    <div
      class="glass relative z-20 flex h-[44px] flex-shrink-0 items-center border-b border-glass-stroke px-3"
      style={{ background: "var(--color-topbar-bg)" }}
    >
      <ProjectSwitcherMenu onBack={props.onBack} />

      {/* center breadcrumb + save indicator */}
      <div class="flex flex-1 items-center justify-center gap-2.5">
        <Show when={breadcrumb()}>
          {(bc) => (
            <div class="glass-soft flex h-7 items-center gap-1.5 rounded-md px-3">
              <Folder size={12} style={{ opacity: 0.5 }} />
              <span class="text-[12px] text-fg-2">{bc().space}</span>
              <span class="text-fg-4">/</span>
              <span class="text-[12px] text-fg-2">{bc().sub}</span>
              <span class="text-fg-4">/</span>
              <span class="text-[12px] font-medium text-fg-1">{bc().file}</span>
            </div>
          )}
        </Show>
        <div class="flex items-center gap-1.5 text-[11px] text-fg-3">
          <span class="relative flex h-1.5 w-1.5">
            <span
              class="pulse absolute inset-0 rounded-full"
              style={{ background: activeFile()?.dirty ? "#F59E0B" : "#10B981" }}
            />
            <span
              class="absolute inset-0 rounded-full opacity-30"
              style={{
                background: activeFile()?.dirty ? "#F59E0B" : "#10B981",
                transform: "scale(1.6)",
              }}
            />
          </span>
          <span>{saveLabel()}</span>
        </div>
      </div>

      {/* right cluster — collaborator avatars only (none until Phase 4) */}
      <div class="flex items-center gap-2">
        <div class="glass-soft flex h-7 items-center gap-1.5 rounded-full px-2.5">
          <span
            class="h-1.5 w-1.5 rounded-full"
            style={{
              background:
                compileState() === "ok"
                  ? "#10B981"
                  : compileState() === "error"
                    ? "#F43F5E"
                    : compileState() === "compiling"
                      ? "#F59E0B"
                      : "#6B7280",
            }}
          />
          <span class="text-[11px] text-fg-2">{compileLabel()}</span>
          <span class="mono text-[11px] text-fg-4">·</span>
          <span class="mono text-[11px] text-fg-2">{compileDuration()}</span>
        </div>
        <button
          type="button"
          class="lift glass-soft flex h-7 items-center gap-1.5 rounded-md px-3 text-[12px] font-medium text-fg-1 hover:bg-[var(--color-control-fill-hover)]"
        >
          <Users size={12} style={{ opacity: 0.7 }} />
          Share
        </button>
        <button
          type="button"
          title="Version history"
          class="lift flex h-9 w-9 items-center justify-center rounded-md hover:bg-[var(--color-control-fill)]"
        >
          <History class="ui-icon-chrome" style={{ opacity: 0.85 }} />
        </button>
        <LayoutMenu />
        <button
          type="button"
          title="Settings"
          onClick={props.onSettings}
          class="lift flex h-9 w-9 items-center justify-center rounded-md hover:bg-[var(--color-control-fill)]"
        >
          <SettingsIcon class="ui-icon-chrome" style={{ opacity: 0.85 }} />
        </button>
      </div>
    </div>
  );
};

const NoProject: Component<{ onBack: () => void }> = (props) => (
  <div class="relative z-10 flex h-full items-center justify-center p-8">
    <Glass class="flex w-[440px] max-w-full flex-col items-center gap-3 p-6 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-glass-fill">
        <FileQuestion size={20} class="text-fg-3" />
      </div>
      <h2 class="text-[14px] font-semibold text-fg-1">No project open</h2>
      <p class="text-[12px] text-fg-3">
        Pick a project from the Projects screen to start editing.
      </p>
      <Button variant="primary" size="md" onClick={props.onBack}>
        Open Projects
      </Button>
    </Glass>
  </div>
);

function joinPath(parent: string, rel: string): string {
  const useBackslash = parent.includes("\\");
  const sep = useBackslash ? "\\" : "/";
  if (parent.endsWith(sep)) return parent + rel;
  return parent + sep + rel;
}

export default EditorScreen;
