import type { Component } from "solid-js";
import { Show, createEffect, lazy, onCleanup, onMount } from "solid-js";
import { Router, Route, useNavigate } from "@solidjs/router";
import { onboarded, settingsLoaded } from "~/stores/settings-store";
// Side-effect imports: instantiate the settings store + theme store on boot
// so their createRoot effects are mounted before any screen renders.
import "~/stores/settings-store";
import { setupAutosave } from "~/lib/autosave";
import { installFrontendErrorHook } from "~/lib/telemetry";
import { bootCoreCommands } from "~/commands/boot";
import { initAiProviders } from "~/integrations/ai/init";
import { initCloudSync } from "~/integrations/cloud/init";
import { initReferenceProviders } from "~/integrations/references/init";
import { initCustomThemes } from "~/themes/custom-themes";
import { loadSupabaseConfig } from "~/config/supabase";
import {
  installGlobalShortcuts,
  uninstallGlobalShortcuts,
} from "~/commands/keyboard";
import { setNavigator } from "~/commands/palette-store";
import { CommandPalette } from "~/components/CommandPalette";
import { Toaster } from "~/components/feedback/Toaster";
import { SaveTemplateDialog } from "~/components/templates/SaveTemplateDialog";
import "@fontsource-variable/inter/index.css";
import "@fontsource-variable/jetbrains-mono/index.css";

const OnboardingScreen = lazy(() => import("~/screens/onboarding/OnboardingScreen"));
const ProjectsScreen = lazy(() => import("~/screens/projects/ProjectsScreen"));
const EditorScreen = lazy(() => import("~/screens/editor/EditorScreen"));
const SettingsScreen = lazy(() => import("~/screens/settings/SettingsScreen"));

setupAutosave();
installFrontendErrorHook();
bootCoreCommands();
initReferenceProviders();
initCloudSync();
initAiProviders();
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
    const [{ startSupabaseSession }, { initSupabaseEntitlements }] =
      await Promise.all([
        import("~/integrations/supabase/session"),
        import("~/integrations/supabase/entitlements-source"),
      ]);
    startSupabaseSession();
    initSupabaseEntitlements();
  })();
}

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

  onMount(() => {
    installGlobalShortcuts();
    bootSupabaseDeferred();
  });

  onCleanup(() => {
    uninstallGlobalShortcuts();
  });

  return (
    <>
      {props.children}
      <CommandPalette />
      <SaveTemplateDialog />
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
