import type { Component } from "solid-js";
import { Show, createEffect, onCleanup, onMount } from "solid-js";
import { Router, Route, useNavigate } from "@solidjs/router";
import { onboarded, settingsLoaded } from "~/stores/settings-store";
import OnboardingScreen from "~/screens/onboarding/OnboardingScreen";
import ProjectsScreen from "~/screens/projects/ProjectsScreen";
import EditorScreen from "~/screens/editor/EditorScreen";
import SettingsScreen from "~/screens/settings/SettingsScreen";
// Side-effect imports: instantiate the settings store + theme store on boot
// so their createRoot effects are mounted before any screen renders.
import "~/stores/settings-store";
import { setupAutosave } from "~/lib/autosave";
import { installFrontendErrorHook } from "~/lib/telemetry";
import { bootCoreCommands } from "~/commands/boot";
import { initAiProviders } from "~/integrations/ai/init";
import { initCloudSync } from "~/integrations/cloud/init";
import { initReferenceProviders } from "~/integrations/references/init";
import { initSupabaseEntitlements } from "~/integrations/supabase/entitlements-source";
import { startSupabaseSession } from "~/integrations/supabase/session";
import {
  installGlobalShortcuts,
  uninstallGlobalShortcuts,
} from "~/commands/keyboard";
import { setNavigator } from "~/commands/palette-store";
import { CommandPalette } from "~/components/CommandPalette";
import "@fontsource/inter/400.css";
import "@fontsource/inter/500.css";
import "@fontsource/inter/600.css";
import "@fontsource/inter/700.css";
import "@fontsource/jetbrains-mono/400.css";
import "@fontsource/jetbrains-mono/500.css";
import "@fontsource/jetbrains-mono/600.css";

setupAutosave();
installFrontendErrorHook();
bootCoreCommands();
startSupabaseSession();
initSupabaseEntitlements();
initReferenceProviders();
initCloudSync();
initAiProviders();

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
  });

  onCleanup(() => {
    uninstallGlobalShortcuts();
  });

  return (
    <>
      {props.children}
      <CommandPalette />
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
