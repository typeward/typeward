import { createEffect, createRoot, createSignal } from "solid-js";
import * as ipc from "~/ipc";
import {
  type Accent,
  type Theme,
  accent,
  setAccent,
  setTheme,
  theme,
} from "~/themes/theme-store";
import {
  activeCustomTheme,
  ambientLights,
  animations,
  customThemesEnabled,
  type Density,
  density,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setCustomThemesEnabled,
  setDensity,
} from "~/stores/ui-store";
import {
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  type ProjectsSort,
  type ProjectsView,
  setDefaultSort,
  setDefaultView,
  setEnableSpaces,
  setEnableTags,
  setNotificationsPanelDefault,
  setWidgetEnabled,
  widgetEnabled,
} from "~/stores/workspace-store";

export type CompileEngine = "system-tex" | "tectonic" | "busytex";

export interface EditorSettings {
  autoCompile: boolean;
  vimMode: boolean;
  spellCheck: boolean;
  lineWrap: boolean;
  fontSize: number;
}

const DEFAULT_EDITOR: EditorSettings = {
  autoCompile: false,
  vimMode: false,
  spellCheck: true,
  lineWrap: true,
  fontSize: 13,
};

const DEFAULT_INTEGRATIONS: ipc.IntegrationsSettings = {
  references: {
    betterBibTex: { enabled: false, libraryId: 1 },
    zoteroWeb: {},
    mendeley: {},
    jabref: { paths: [] },
  },
  cloud: { accounts: [] },
  vcs: { git: {}, github: {} },
  ai: { perProviderModel: {} },
  grammar: { enabled: false },
  templates: { recentTemplateIds: [] },
  account: {},
};

const [editorSettings, setEditorSettings] = createSignal<EditorSettings>({
  ...DEFAULT_EDITOR,
});
const [projectsRoot, setProjectsRoot] = createSignal<string>("");
const [compileEngine, setCompileEngine] = createSignal<CompileEngine>("system-tex");
const [onboarded, setOnboarded] = createSignal<boolean>(false);
const [integrationsSettings, setIntegrationsSettings] =
  createSignal<ipc.IntegrationsSettings>(DEFAULT_INTEGRATIONS);
const [settingsLoaded, setSettingsLoaded] = createSignal<boolean>(false);

createRoot(() => {
  void (async () => {
    try {
      const s = await ipc.loadSettings();
      setTheme(s.theme as Theme);
      setAccent(s.accent as Accent);
      setEditorSettings(s.editor);
      setProjectsRoot(s.projectsRoot);
      setCompileEngine(s.compileEngine as CompileEngine);
      setOnboarded(s.onboarded);

      setDensity(s.ui.density as Density);
      setAnimations(s.ui.animations);
      setAmbientLights(s.ui.ambientLights);
      setCustomThemesEnabled(s.ui.customThemesEnabled);
      setActiveCustomTheme(s.ui.activeCustomTheme);

      setEnableSpaces(s.workspace.enableSpaces);
      setEnableTags(s.workspace.enableTags);
      setNotificationsPanelDefault(s.workspace.notificationsPanelDefault);
      setDefaultView(s.workspace.defaultView as ProjectsView);
      setDefaultSort(s.workspace.defaultSort as ProjectsSort);
      setWidgetEnabled(s.workspace.widgets);

      if (s.integrations) {
        setIntegrationsSettings({ ...DEFAULT_INTEGRATIONS, ...s.integrations });
      }
    } catch {
      // First boot or non-Tauri context (Vitest); leave defaults in place.
    } finally {
      setSettingsLoaded(true);
    }
  })();

  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  createEffect(() => {
    const next: ipc.AppSettings = {
      theme: theme(),
      accent: accent(),
      editor: editorSettings(),
      projectsRoot: projectsRoot(),
      compileEngine: compileEngine(),
      onboarded: onboarded(),
      ui: {
        density: density(),
        animations: animations(),
        ambientLights: ambientLights(),
        customThemesEnabled: customThemesEnabled(),
        activeCustomTheme: activeCustomTheme(),
      },
      workspace: {
        enableSpaces: enableSpaces(),
        enableTags: enableTags(),
        notificationsPanelDefault: notificationsPanelDefault(),
        defaultView: defaultView(),
        defaultSort: defaultSort(),
        widgets: widgetEnabled(),
      },
      integrations: integrationsSettings(),
    };
    if (!settingsLoaded()) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      void ipc.saveSettings(next).catch(() => {
        // Swallow in dev / non-Tauri contexts.
      });
    }, 250);
  });
});

export {
  compileEngine,
  editorSettings,
  integrationsSettings,
  onboarded,
  projectsRoot,
  settingsLoaded,
  setCompileEngine,
  setEditorSettings,
  setIntegrationsSettings,
  setOnboarded,
  setProjectsRoot,
};
