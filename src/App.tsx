import type { Component } from "solid-js";
import { ErrorBoundary, Show, Suspense, createEffect, createSignal, lazy, onCleanup, onMount } from "solid-js";
import { Router, Route, useNavigate } from "@solidjs/router";
import {
  onboarded,
  settingsLoaded,
  shareCrashReports,
  updatesCheckAutomatically,
} from "~/stores/settings-store";
import { refresh as refreshProjects } from "~/stores/projects-store";
import { describeIpcError } from "~/lib/errors";
// Side-effect imports: instantiate the settings store + theme store on boot
// so their createRoot effects are mounted before any screen renders.
import "~/stores/settings-store";
import { setupAutosave } from "~/lib/autosave";
import { installSentryGate } from "~/lib/sentry-gate";
import { installFrontendErrorHook, recordError } from "~/lib/telemetry";
import { bootCoreCommands } from "~/commands/boot";
import { registerAiEditorActions } from "~/integrations/ai/editor-actions";
import { initAiProviders } from "~/integrations/ai/init";
import { initCloudSync } from "~/integrations/cloud/init";
import { initReferenceProviders } from "~/integrations/references/init";
import { initCustomThemes } from "~/themes/custom-themes";
import {
  installGlobalShortcuts,
  uninstallGlobalShortcuts,
} from "~/commands/keyboard";
import {
  requestAiAction_,
  requestRenameLabel_,
  requestSaveTemplate_,
  requestUpdateDialog_,
  setNavigator,
} from "~/commands/palette-store";
import { installMenuBridge } from "~/lib/menu-bridge";
import { installOpenWith } from "~/lib/open-with";
import { scheduleBootUpdateCheck } from "~/lib/updater";
import { CommandPalette } from "~/components/CommandPalette";
import { Toaster } from "~/components/feedback/Toaster";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/inter/wght-italic.css";
import "@fontsource-variable/jetbrains-mono/index.css";
import "@fontsource-variable/jetbrains-mono/wght-italic.css";

const OnboardingScreen = lazy(() => import("~/screens/onboarding/OnboardingScreen"));
const ProjectsScreen = lazy(() => import("~/screens/projects/ProjectsScreen"));
const EditorScreen = lazy(() => import("~/screens/editor/EditorScreen"));
const SettingsScreen = lazy(() => import("~/screens/settings/SettingsScreen"));
// The lazy dialog's chunk (Kobalte Dialog machinery) stays off the boot path;
// it only loads the first time core.saveTemplate fires.
const SaveTemplateDialog = lazy(() =>
  import("~/components/templates/SaveTemplateDialog").then((m) => ({
    default: m.SaveTemplateDialog,
  })),
);
const RenameLabelDialog = lazy(() =>
  import("~/components/editor/RenameLabelDialog").then((m) => ({
    default: m.RenameLabelDialog,
  })),
);
// Lazy like the others — the updater plugin JS and this dialog's chunk stay
// off the boot path until an update is actually found.
const UpdateDialog = lazy(() =>
  import("~/components/updates/UpdateDialog").then((m) => ({
    default: m.UpdateDialog,
  })),
);
// Lazy like the other dialogs — the diff stack (@codemirror/merge) inside
// stays a dynamic import of its own, so nothing heavy loads until an AI
// editor action actually runs.
const AiActionDialog = lazy(() =>
  import("~/components/editor/AiActionDialog").then((m) => ({
    default: m.AiActionDialog,
  })),
);

// Overlap the boot waterfall: fetch/parse the ProjectsScreen chunk while the
// load_settings IPC is still in flight (the RootRoute render gate only needs
// to hold RENDERING, not the chunk fetch).
void ProjectsScreen.preload();

setupAutosave();
installFrontendErrorHook();
installSentryGate();
bootCoreCommands();
initReferenceProviders();
initCloudSync();
initAiProviders();
registerAiEditorActions();
initCustomThemes();

/**
 * Recoverable fallback for a render/effect throw anywhere under the app shell.
 * Without a boundary, one uncaught throw blanks the whole webview with nothing
 * but telemetry.log as evidence; here the error is logged and the user gets a
 * "Try again" that resets the boundary (re-rendering the subtree).
 */
const AppCrash: Component<{ err: unknown; reset: () => void }> = (props) => {
  recordError("ui-crash", "render error caught by app ErrorBoundary", props.err);
  // Boundary-caught errors never reach window.onerror, so Sentry's global
  // handlers can't see them — report explicitly, but only when the user has
  // opted into crash reporting (otherwise this would fetch the SDK chunk for
  // a no-op: reportCrash is a no-op on an uninitialized client anyway).
  if (shareCrashReports()) {
    void import("~/lib/sentry").then((m) => m.reportCrash(props.err)).catch(() => {});
  }
  return (
    <div
      role="alert"
      style={{
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "14px",
        height: "100vh",
        padding: "24px",
        "text-align": "center",
      }}
    >
      <div class="glass" style={{ padding: "24px 28px", "border-radius": "14px", "max-width": "480px" }}>
        <div class="text-base font-medium text-fg-1">Something went wrong</div>
        <p class="mt-2 select-text break-words text-sm text-fg-3">
          {describeIpcError(props.err)}
        </p>
        <button
          type="button"
          class="lift accent-grad mt-4 rounded-lg px-4 py-2 text-sm font-medium text-accent-fg"
          onClick={props.reset}
        >
          Try again
        </button>
      </div>
    </div>
  );
};

/**
 * Default `/` route. After settings load, if the user hasn't completed
 * onboarding yet, redirect them. Otherwise render Projects.
 *
 * We wait for `settingsLoaded()` before rendering Projects — otherwise a
 * fresh install briefly flashes Projects then jumps to Onboarding.
 */
const RootRoute: Component = () => {
  const navigate = useNavigate();
  createEffect(() => {
    if (settingsLoaded() && !onboarded()) {
      navigate("/onboarding", { replace: true });
    }
  });
  return (
    <Show when={settingsLoaded()} fallback={null}>
      <ProjectsScreen />
    </Show>
  );
};

/**
 * Captures useNavigate() once inside the Router so module-level actions
 * (fired from keyboard shortcuts, palette selections) can route the user
 * without a hand-rolled router. Also installs/uninstalls the global
 * keyboard router and renders the shared command palette overlay.
 */
const AppShell: Component<{ children?: any }> = (props) => {
  const navigate = useNavigate();
  setNavigator((path: string) => navigate(path));

  // macOS menu "Close Tab" (Cmd+W) fallback: EditorScreen owns the listener
  // while it's mounted (close tab, else close window); on every other screen
  // the emit would land with no consumer and Cmd+W would go dead — here it
  // falls through to the window-close guard. The [data-editor-shell] probe is
  // the same mount marker the keyboard router scopes on.
  let unlistenMenuCloseTab: (() => void) | undefined;
  let menuCloseTabDisposed = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlistenMenuCloseTab = await listen("menu:close-tab", () => {
        if (document.querySelector("[data-editor-shell]") !== null) return;
        void (async () => {
          try {
            const { getCurrentWindow } = await import("@tauri-apps/api/window");
            // close(), not destroy() — onCloseRequested must get its prompt.
            await getCurrentWindow().close();
          } catch {
            /* non-Tauri context */
          }
        })();
      });
      if (menuCloseTabDisposed) {
        unlistenMenuCloseTab();
        unlistenMenuCloseTab = undefined;
      }
    } catch {
      /* non-Tauri context */
    }
  })();
  onCleanup(() => {
    menuCloseTabDisposed = true;
    unlistenMenuCloseTab?.();
  });

  // Native-shell bridges. The menu bridge only ever receives events on macOS
  // (nothing emits "menu:command" elsewhere), so mounting it unconditionally
  // is harmless; open-with handles OS "Open with Typeward" file paths from
  // the single-instance callback and the deferred first-launch emit.
  const uninstallMenuBridge = installMenuBridge();
  const uninstallOpenWith = installOpenWith();
  onCleanup(() => {
    uninstallMenuBridge();
    uninstallOpenWith();
  });

  // Suppress the webview's browser context menu (Reload / Inspect) on app
  // chrome; editable surfaces keep it for native cut/copy/paste, and so do
  // copyable read-only surfaces (logs, previews, selected text) — killing
  // the menu there would kill right-click Copy. `.cm-content` is intentionally
  // absent: the editor renders its own ContextMenu (text-shell), which
  // stopPropagation()s before this handler runs, so a failed open never falls
  // back to the browser menu.
  const onContextMenu = (e: MouseEvent) => {
    const t = e.target instanceof Element ? e.target : null;
    if (
      t?.closest(
        'input, textarea, [contenteditable="true"], .select-text, .select-all, .md-preview',
      )
    )
      return;
    const sel = window.getSelection();
    if (sel && !sel.isCollapsed && t && sel.containsNode(t, true)) return;
    e.preventDefault();
  };

  // Kick the list_projects IPC the moment settings resolve so it overlaps
  // the ProjectsScreen chunk fetch/parse instead of waiting for the screen's
  // onMount (whose refresh() stays as an idempotent re-sync).
  let libraryPrefetched = false;
  createEffect(() => {
    if (settingsLoaded() && !libraryPrefetched) {
      libraryPrefetched = true;
      void refreshProjects();
    }
  });

  // Latches on the first save-template request and stays mounted afterwards
  // so Kobalte's close animation and later opens keep working; until then
  // the dialog chunk is never fetched.
  const [saveTemplateTouched, setSaveTemplateTouched] = createSignal(false);
  createEffect(() => {
    if (requestSaveTemplate_()) setSaveTemplateTouched(true);
  });
  const [updateDialogTouched, setUpdateDialogTouched] = createSignal(false);
  createEffect(() => {
    if (requestUpdateDialog_()) setUpdateDialogTouched(true);
  });
  const [aiActionTouched, setAiActionTouched] = createSignal(false);
  createEffect(() => {
    if (requestAiAction_()) setAiActionTouched(true);
  });
  const [renameLabelTouched, setRenameLabelTouched] = createSignal(false);
  createEffect(() => {
    if (requestRenameLabel_()) setRenameLabelTouched(true);
  });

  let cancelBootUpdateCheck: (() => void) | undefined;
  onMount(() => {
    installGlobalShortcuts();
    document.addEventListener("contextmenu", onContextMenu);
    // Delayed post-paint update check — dormant until a pubkey is configured
    // AND the user leaves auto-checking on; never blocks startup.
    cancelBootUpdateCheck = scheduleBootUpdateCheck(updatesCheckAutomatically);
  });

  onCleanup(() => {
    uninstallGlobalShortcuts();
    document.removeEventListener("contextmenu", onContextMenu);
    cancelBootUpdateCheck?.();
  });

  return (
    <>
      <ErrorBoundary fallback={(err, reset) => <AppCrash err={err} reset={reset} />}>
        {props.children}
      </ErrorBoundary>
      <CommandPalette />
      <Show when={saveTemplateTouched()}>
        <Suspense>
          <SaveTemplateDialog />
        </Suspense>
      </Show>
      <Show when={renameLabelTouched()}>
        <Suspense>
          <RenameLabelDialog />
        </Suspense>
      </Show>
      <Show when={updateDialogTouched()}>
        <Suspense>
          <UpdateDialog />
        </Suspense>
      </Show>
      <Show when={aiActionTouched()}>
        <Suspense>
          <AiActionDialog />
        </Suspense>
      </Show>
      <Toaster />
    </>
  );
};

const App: Component = () => {
  return (
    <Router root={AppShell}>
      <Route path="/" component={RootRoute} />
      <Route path="/onboarding" component={OnboardingScreen} />
      <Route path="/projects" component={ProjectsScreen} />
      <Route path="/editor" component={EditorScreen} />
      <Route path="/settings" component={SettingsScreen} />
    </Router>
  );
};

export default App;
