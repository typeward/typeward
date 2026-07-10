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
import { PRO_DISCOVERY_ENABLED } from "~/config/pro";
import { registerAiEditorActions } from "~/integrations/ai/editor-actions";
import { initAiProviders } from "~/integrations/ai/init";
import { initCloudSync } from "~/integrations/cloud/init";
import { initReferenceProviders } from "~/integrations/references/init";
import { initCustomThemes } from "~/themes/custom-themes";
import { loadSupabaseConfig } from "~/config/supabase";
import {
  installGlobalShortcuts,
  uninstallGlobalShortcuts,
} from "~/commands/keyboard";
import {
  requestAiAction_,
  requestFeedbackCard_,
  requestProDialog_,
  requestSaveTemplate_,
  requestUpdateDialog_,
  setNavigator,
} from "~/commands/palette-store";
import { scheduleFeedbackPrompt } from "~/lib/feedback-prompt";
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
// Same treatment as SaveTemplateDialog — the ProDialog chunk also pulls the
// supabase session module, which must stay off the boot path.
const ProDialog = lazy(() =>
  import("~/components/entitlement/ProDialog").then((m) => ({
    default: m.ProDialog,
  })),
);
// Lazy like the others — the updater plugin JS and this dialog's chunk stay
// off the boot path until an update is actually found.
const UpdateDialog = lazy(() =>
  import("~/components/updates/UpdateDialog").then((m) => ({
    default: m.UpdateDialog,
  })),
);
// Lazy like ProDialog — the diff stack (@codemirror/merge) inside stays a
// dynamic import of its own, so nothing heavy loads until an AI editor
// action actually runs.
const AiActionDialog = lazy(() =>
  import("~/components/editor/AiActionDialog").then((m) => ({
    default: m.AiActionDialog,
  })),
);
// Lazy like the dialogs — most sessions never open the feedback card, so its
// chunk (submission + card UI) stays off the boot path until one does.
const FeedbackCard = lazy(() =>
  import("~/components/feedback/FeedbackCard").then((m) => ({
    default: m.FeedbackCard,
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
 * Supabase auth/session + entitlement boot is deferred behind a dynamic
 * import so `@supabase/supabase-js` stays out of the entry chunk and never
 * parses during cold launch (to first paint). When Supabase isn't configured
 * (no env vars) the chunk is never fetched — `loadSupabaseConfig()` only reads
 * `import.meta.env` and doesn't pull in the client. Scheduled post-first-paint
 * from AppShell's onMount. Entitlement consumers stay on the synchronous
 * free-tier default until the source swap resolves (FeatureGate defaults
 * closed and is reactive), matching the pre-existing async behavior.
 */
function bootSupabaseDeferred(): void {
  if (!loadSupabaseConfig()) return;
  void (async () => {
    const [{ startSupabaseSession }, { initSupabaseEntitlements }, { initSettingsSync }] =
      await Promise.all([
        import("~/integrations/supabase/session"),
        import("~/integrations/supabase/entitlements-source"),
        import("~/integrations/supabase/settings-sync"),
      ]);
    startSupabaseSession();
    initSupabaseEntitlements();
    initSettingsSync();
  })();
}

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
  // Never latches while Pro discovery is off (free-only beta) — the dialog
  // stays unmounted and its chunk unfetched even if a stray request fires.
  const [proDialogTouched, setProDialogTouched] = createSignal(false);
  createEffect(() => {
    if (PRO_DISCOVERY_ENABLED && requestProDialog_()) setProDialogTouched(true);
  });
  const [updateDialogTouched, setUpdateDialogTouched] = createSignal(false);
  createEffect(() => {
    if (requestUpdateDialog_()) setUpdateDialogTouched(true);
  });
  const [aiActionTouched, setAiActionTouched] = createSignal(false);
  createEffect(() => {
    if (requestAiAction_()) setAiActionTouched(true);
  });
  const [feedbackTouched, setFeedbackTouched] = createSignal(false);
  createEffect(() => {
    if (requestFeedbackCard_()) setFeedbackTouched(true);
  });

  let cancelBootUpdateCheck: (() => void) | undefined;
  let cancelFeedbackPrompt: (() => void) | undefined;
  onMount(() => {
    installGlobalShortcuts();
    document.addEventListener("contextmenu", onContextMenu);
    bootSupabaseDeferred();
    // Delayed post-paint update check — dormant until a pubkey is configured
    // AND the user leaves auto-checking on; never blocks startup.
    cancelBootUpdateCheck = scheduleBootUpdateCheck(updatesCheckAutomatically);
    // Occasional feedback prompt — records the session, then maybe raises the
    // card after the same post-paint deferral shape as the update check.
    cancelFeedbackPrompt = scheduleFeedbackPrompt();
  });

  onCleanup(() => {
    uninstallGlobalShortcuts();
    document.removeEventListener("contextmenu", onContextMenu);
    cancelBootUpdateCheck?.();
    cancelFeedbackPrompt?.();
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
      <Show when={proDialogTouched()}>
        <Suspense>
          <ProDialog />
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
      <Show when={feedbackTouched()}>
        <Suspense>
          <FeedbackCard />
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
