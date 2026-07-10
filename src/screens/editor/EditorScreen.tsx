import { useNavigate, useSearchParams } from "@solidjs/router";
import {
  FileQuestion,
  Folder,
  Settings as SettingsIcon,
} from "lucide-solid";
import { LayoutMenu } from "~/components/editor/LayoutMenu";
import { ProjectSwitcherMenu } from "~/components/editor/ProjectSwitcherMenu";
import { SyncStatusBadge } from "~/components/sync/SyncStatusBadge";
import type { Component } from "solid-js";
import { Match, Show, Switch, createEffect, createMemo, createSignal, onCleanup } from "solid-js";
import { AmbientBackdrop } from "~/components/layout/AmbientBackdrop";
import { Glass } from "~/components/glass/Glass";
import { Button } from "~/components/primitives/Button";
import { RecoveryDialog } from "~/components/editor/RecoveryDialog";
import {
  errorText,
  notifyError,
  notifyInfo,
} from "~/components/feedback/Toaster";
import * as ipc from "~/ipc";
import {
  activateFileIfOpen,
  activeFile,
  compileState,
  gotoSourceIntent,
  lastResult,
  openFile as openFileInStore,
  openFiles,
  project,
  resetCompileState,
  resetTabs,
  restoreFileContent,
  setProject,
} from "~/stores/editor-store";
import { sha256Hex } from "~/lib/hash";
import { setCursorLine, setSelectionRange } from "~/stores/editor-view-store";
import { setPreviousRoute } from "~/stores/nav-store";
import {
  abortActiveAiStream,
  flushPendingAiChatSaves,
} from "~/stores/ai-chat-store";
import {
  flushPendingReviewSave,
  loadThreads,
  resetThreads,
} from "~/stores/review-store";
import { hasEntitlement } from "~/integrations/entitlements";
import { startSession, stopAllSessions } from "~/stores/lsp-store";
import { startWatching, stopWatching } from "~/stores/watcher-store";
import { TextShell } from "./shells/text-shell";
import { createAsyncGenerationGuard } from "~/lib/async-generation";
import { adapterFor } from "~/commands/actions";
import { asLspLanguage } from "~/adapters/languages";
import {
  registerAdapterCommands,
  unregisterAdapterCommands,
} from "~/commands/boot";
import { focusMode } from "~/stores/ui-store";
import type { EditorAdapter } from "~/adapters/types";

const BINARY_EXT = /\.(png|jpe?g|gif|pdf|eps|webp|bmp|ico|woff2?|ttf|otf|zip)$/i;

const EditorScreen: Component = () => {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const [orphans, setOrphans] = createSignal<ipc.Snapshot[]>([]);
  const [recoveryOpen, setRecoveryOpen] = createSignal(false);
  // True while the open chain for ?path is in flight and no project is
  // mounted yet — drives the "Opening…" state instead of a misleading
  // "No project open" flash on every cold open.
  const [opening, setOpening] = createSignal(false);
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
      setOpening(false);
      void stopAllSessions();
      void stopWatching();
      teardownAdapter();
      void flushPendingReviewSave().then(resetThreads);
      setProject(null);
      resetTabs();
      resetCompileState();
      return;
    }
    setOpening(true);
    void (async () => {
      try {
        const p = await ipc.openProject(path);
        if (!token.isCurrent()) return;
        // A trashed project must not open (covers palette / switcher / deep
        // links). Bounce back to the library without stamping last-opened.
        if (p.trashedAt != null) {
          notifyError(
            "Project is in the trash",
            "Restore it from the library to open it.",
          );
          setOpening(false);
          void stopAllSessions();
          void stopWatching();
          teardownAdapter();
          void flushPendingReviewSave().then(resetThreads);
          setProject(null);
          resetTabs();
          resetCompileState();
          navigate("/projects");
          return;
        }
        // Tear down the previous project's LSP sessions fire-and-forget: the
        // session registry empties synchronously, per-start server ids can't
        // collide, and awaiting the shutdown handshake would let a wedged
        // language server stall the new project's first paint for up to 2s.
        void stopAllSessions();
        await stopWatching();
        // Persist any pending review-comment save to the *previous* project
        // before its threads are cleared.
        await flushPendingReviewSave();
        if (!token.isCurrent()) return;
        teardownAdapter();
        setProject(p);
        // Stamp last-opened for the library's "Last opened" sort. Single
        // chokepoint — every open routes through here. Fire-and-forget.
        void ipc.touchProjectOpened(p.rootPath).catch(() => {});
        setOpening(false);
        resetTabs();
        resetCompileState();
        resetThreads();
        void loadThreads(token.isCurrent);
        // Bind the matching adapter's commands into the registry so the
        // palette and Mod+Enter work format-specifically.
        const adapter = adapterFor(p);
        registerAdapterCommands(adapter);
        registeredAdapter = adapter;
        // Start the file watcher so external edits / new files / deletions
        // refresh the FileTree (it reads `fsVersion` as a resource source).
        void startWatching(p.rootPath, token.isCurrent);
        // Start the LSP for the adapter's primary language. Silently no-ops if
        // the binary isn't installed or the format ships no language server.
        // tinymist belongs to the Pro Typst surface; texlab stays free.
        const lspLang = asLspLanguage(adapter.languageId);
        if (lspLang && (lspLang !== "typst" || hasEntitlement("formats.typst")))
          void startSession(lspLang, p, token.isCurrent);
        // Recovery is fire-and-forget so the snapshot-dir walk never gates
        // the root file's first paint; the dialog opening a beat later is
        // fine (handleRestore replaces content in already-open tabs).
        void (async () => {
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
        })();
        await openFile(p.rootFile, p, token.isCurrent);
      } catch (e) {
        if (!token.isCurrent()) return;
        console.error("Failed to open project", e);
        notifyError("Couldn't open project", errorText(e));
        // The previous project's runtime must not outlive its blanked UI.
        setOpening(false);
        void stopAllSessions();
        void stopWatching();
        teardownAdapter();
        void flushPendingReviewSave().then(resetThreads);
        setProject(null);
        resetTabs();
        resetCompileState();
      }
    })();
  });

  onCleanup(() => {
    loadGuard.invalidate();
    void stopAllSessions();
    void stopWatching();
    teardownAdapter();
    void flushPendingReviewSave().then(resetThreads);
  });

  // Closing a tab confirms discarding a dirty buffer; closing the window has
  // to as well, or the same edits vanish without a prompt.
  let unlistenClose: (() => void) | undefined;
  let closeGuardDisposed = false;
  void (async () => {
    try {
      const { getCurrentWindow } = await import("@tauri-apps/api/window");
      const win = getCurrentWindow();
      unlistenClose = await win.onCloseRequested(async (event) => {
        const dirty = openFiles().filter((f) => f.dirty).length;
        if (dirty === 0) {
          // No dirty files, but a review-comment save may still be pending on
          // the debounce — flush it before the window goes away, or the last
          // comment edits are lost (they don't mark any file dirty). Same for
          // a debounced AI-conversation save; an in-flight AI stream is
          // aborted so the Rust task doesn't outlive the window.
          event.preventDefault();
          abortActiveAiStream();
          try {
            await flushPendingReviewSave();
            await flushPendingAiChatSaves();
          } catch {
            /* never block window close on a review-save failure */
          }
          void win.destroy();
          return;
        }
        event.preventDefault();
        let discard = false;
        try {
          const { ask } = await import("@tauri-apps/plugin-dialog");
          discard = await ask(
            `Close without saving? ${dirty} ${dirty === 1 ? "file has" : "files have"} unsaved changes.`,
            {
              title: "Unsaved changes",
              kind: "warning",
              okLabel: "Close anyway",
              cancelLabel: "Keep editing",
            },
          );
        } catch {
          discard = window.confirm(
            `Close without saving? ${dirty} file(s) have unsaved changes.`,
          );
        }
        // destroy(), not close() — close() would re-fire this handler.
        if (discard) {
          abortActiveAiStream();
          try {
            await flushPendingReviewSave();
            await flushPendingAiChatSaves();
          } catch {
            /* never block window close on a review-save failure */
          }
          void win.destroy();
        }
      });
      // Unmount can win the race against the listen() roundtrip — drop the
      // registration immediately or it leaks for the session.
      if (closeGuardDisposed) {
        unlistenClose();
        unlistenClose = undefined;
      }
    } catch {
      /* non-Tauri context — no window close to guard */
    }
  })();
  onCleanup(() => {
    closeGuardDisposed = true;
    unlistenClose?.();
  });

  const openFile = async (
    relPath: string,
    ownerProject: NonNullable<ReturnType<typeof project>> | null = project(),
    isCurrent: () => boolean = () => true,
  ) => {
    const p = ownerProject;
    if (!p) return;
    // The FileTree lists figures and other binaries; the text-read IPC would
    // reject them with a raw UTF-8 error, so answer the click up front.
    if (BINARY_EXT.test(relPath)) {
      notifyInfo("Binary file", "This file can't be opened in the text editor.");
      return;
    }
    const abs = joinPath(p.rootPath, relPath);
    // Already open: activate the tab directly — the store's dedupe branch
    // would discard a fresh disk read anyway, so skip the IPC round-trip.
    if (activateFileIfOpen(abs)) return;
    try {
      const content = await ipc.readProjectTextFile(p.rootPath, relPath);
      if (!isCurrent()) return;
      // Record the hash of the content we loaded from disk so the save path can
      // later tell whether the file changed underneath the buffer.
      const baseHash = await sha256Hex(content);
      if (!isCurrent()) return;
      openFileInStore({ path: abs, relPath, content, dirty: false, baseHash });
    } catch (e) {
      console.error("Failed to read file", abs, e);
      notifyError("Couldn't open file", errorText(e));
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
  let pendingIntentRange: { from: number; to: number } | undefined;

  createEffect(() => {
    const intent = gotoSourceIntent();
    if (!intent) return;
    if (intent.generation <= lastHandledGeneration) return;
    // Capture intent details for the follow-up active-file effect.
    pendingIntentRelPath = intent.relPath;
    pendingIntentLine = intent.line;
    pendingIntentRange = intent.range;
    lastHandledGeneration = intent.generation;

    const f = activeFile();
    if (f && f.relPath === intent.relPath) {
      // Already open and active — move the cursor on the next microtask
      // so any pending edits settle first.
      const range = intent.range;
      queueMicrotask(() => {
        if (range) setSelectionRange(range.from, range.to);
        else setCursorLine(intent.line);
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
    const range = pendingIntentRange;
    queueMicrotask(() => {
      if (range) setSelectionRange(range.from, range.to);
      else setCursorLine(line);
    });
    pendingIntentRelPath = null;
  });

  const handleRestore = async (snapshots: ipc.Snapshot[]) => {
    const p = project();
    if (!p) return;
    // Restore every orphaned snapshot. The most common orphan is the root
    // file, which project load already opened as a clean tab — restoring into
    // an existing tab must replace its content (and mark it dirty), not be
    // discarded because the path is already open.
    for (const snap of snapshots) {
      restoreFileContent({
        path: joinPath(p.rootPath, snap.relPath),
        relPath: snap.relPath,
        content: snap.content,
        dirty: true,
      });
    }
  };

  return (
    <div class="no-emoji relative h-full w-full overflow-hidden bg-bg-base">
      <AmbientBackdrop />
      <Switch>
        <Match when={!project() && opening()}>
          <OpeningProject
            name={
              typeof params.path === "string"
                ? params.path.replace(/[\\/]+$/, "").split(/[\\/]/).pop() ?? ""
                : ""
            }
          />
        </Match>
        <Match when={!project()}>
          <NoProject onBack={() => navigate("/projects")} />
        </Match>
        <Match when={project()}>
          <div class="relative z-10 flex h-full flex-col">
            <Show when={!focusMode()}>
              <EditorTopBar
                onBack={() => navigate("/projects")}
                onSettings={() => {
                  // Keep the ?path= query — a bare "/editor" return route
                  // makes EditorScreen tear the project down and strand the
                  // user on "No project open".
                  const p = project();
                  setPreviousRoute(
                    p
                      ? `/editor?path=${encodeURIComponent(p.rootPath)}`
                      : "/projects",
                  );
                  navigate("/settings");
                }}
              />
            </Show>
            <div class="flex min-h-0 flex-1 gap-2 p-2">
              <TextShell onSelectFile={(rel) => void openFile(rel)} />
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
    const rel = (f?.relPath ?? p.rootFile).replace(/\\/g, "/");
    const segs = rel.split("/");
    const file = segs.pop() ?? rel;
    return { space: p.name, sub: segs.join("/"), file };
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
              <span class="text-sm text-fg-2">{bc().space}</span>
              <Show when={bc().sub}>
                <span class="text-fg-4">/</span>
                <span class="text-sm text-fg-2">{bc().sub}</span>
              </Show>
              <span class="text-fg-4">/</span>
              <span class="text-sm font-medium text-fg-1">{bc().file}</span>
            </div>
          )}
        </Show>
        <div class="flex items-center gap-1.5 text-xs text-fg-3">
          <span class="relative flex h-1.5 w-1.5">
            {/* Pulse only while unsaved — a perpetual animation keeps the
                compositor from ever reaching idle for the whole session. */}
            <span
              class={`${activeFile()?.dirty ? "pulse " : ""}absolute inset-0 rounded-full`}
              style={{ background: activeFile()?.dirty ? "var(--color-warn)" : "var(--color-ok)" }}
            />
            <span
              class="absolute inset-0 rounded-full opacity-30"
              style={{
                background: activeFile()?.dirty ? "var(--color-warn)" : "var(--color-ok)",
                transform: "scale(1.6)",
              }}
            />
          </span>
          <span>{saveLabel()}</span>
        </div>
      </div>

      {/* right cluster — collaborator avatars only (none until Phase 4) */}
      <div class="flex items-center gap-2">
        {/* role=status: the only live region compile results ever reach —
            keeps success/failure announced to assistive tech. */}
        <div
          role="status"
          class="glass-soft flex h-7 items-center gap-1.5 rounded-full px-2.5"
        >
          <span
            class="h-1.5 w-1.5 rounded-full"
            style={{
              background:
                compileState() === "ok"
                  ? "var(--color-ok)"
                  : compileState() === "error"
                    ? "var(--color-err)"
                    : compileState() === "compiling"
                      ? "var(--color-warn)"
                      : "var(--color-fg-4)",
            }}
          />
          <span class="text-xs text-fg-2">{compileLabel()}</span>
          <span class="mono text-xs text-fg-4">·</span>
          <span class="mono text-xs text-fg-2">{compileDuration()}</span>
        </div>
        <SyncStatusBadge />
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

const OpeningProject: Component<{ name: string }> = (props) => (
  <div class="relative z-10 flex h-full items-center justify-center p-8">
    <Glass class="flex w-[440px] max-w-full flex-col items-center gap-3 p-6 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-glass-fill">
        <Folder size={20} class="text-fg-3" />
      </div>
      <h2 class="text-base font-semibold text-fg-1">
        Opening {props.name || "project"}…
      </h2>
    </Glass>
  </div>
);

const NoProject: Component<{ onBack: () => void }> = (props) => (
  <div class="relative z-10 flex h-full items-center justify-center p-8">
    <Glass class="flex w-[440px] max-w-full flex-col items-center gap-3 p-6 text-center">
      <div class="flex h-10 w-10 items-center justify-center rounded-full bg-glass-fill">
        <FileQuestion size={20} class="text-fg-3" />
      </div>
      <h2 class="text-base font-semibold text-fg-1">No project open</h2>
      <p class="text-sm text-fg-3">
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
