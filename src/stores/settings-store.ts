import { createEffect, createRoot, createSignal } from "solid-js";
import * as ipc from "~/ipc";
import { isTauriMobile } from "~/lib/platform";
import {
  ACCENTS,
  type Accent,
  THEMES,
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
  dashboardEnabled,
  dashboardOrder,
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  projectCardWords,
  type ProjectsSort,
  type ProjectsView,
  setDashboardEnabled,
  setDashboardOrder,
  setDefaultSort,
  setDefaultView,
  setEnableSpaces,
  setEnableTags,
  setNotificationsPanelDefault,
  setProjectCardWords,
  setStatsCards,
  setWidgetEnabled,
  statsCards,
  widgetEnabled,
} from "~/stores/workspace-store";

export type CompileEngine = "system-tex" | "tectonic" | "texlive-wasm";

/**
 * settings.json is an external boundary — values may predate the current
 * enum (removed themes, renamed sorts). An invalid value would otherwise be
 * applied verbatim AND re-persisted, making it sticky forever.
 */
export function validEnum<T extends string>(
  raw: string,
  allowed: readonly T[],
  fallback: T,
): T {
  return (allowed as readonly string[]).includes(raw) ? (raw as T) : fallback;
}

function migrateCompileEngine(raw: string): CompileEngine {
  if (raw === "busytex") {
    return isTauriMobile() ? "texlive-wasm" : "system-tex";
  }
  if (raw === "texlive-wasm" && !isTauriMobile()) {
    return "system-tex";
  }
  if (raw === "system-tex" || raw === "tectonic" || raw === "texlive-wasm") {
    return raw;
  }
  return isTauriMobile() ? "texlive-wasm" : "system-tex";
}

export interface EditorSettings {
  autoCompile: boolean;
  vimMode: boolean;
  spellCheck: boolean;
  lineWrap: boolean;
  fontSize: number;
  /** Pass -halt-on-error to latexmk/pdflatex (Tectonic always halts). */
  stopOnFirstError: boolean;
}

const DEFAULT_EDITOR: EditorSettings = {
  autoCompile: false,
  vimMode: false,
  spellCheck: true,
  lineWrap: true,
  fontSize: 13,
  stopOnFirstError: true,
};

const DEFAULT_INTEGRATIONS: ipc.IntegrationsSettings = {
  references: {
    betterBibTex: { enabled: false },
    zoteroWeb: {},
    mendeley: {},
  },
  cloud: { accounts: [] },
  vcs: { git: {}, github: {} },
  ai: { enabled: true, perProviderModel: {} },
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
      setTheme(validEnum<Theme>(s.theme, THEMES, "daylight"));
      setAccent(validEnum<Accent>(s.accent, ACCENTS, "violet-cyan"));
      setEditorSettings(s.editor);
      setProjectsRoot(s.projectsRoot);
      setCompileEngine(migrateCompileEngine(s.compileEngine));
      setOnboarded(s.onboarded);

      setDensity(
        validEnum<Density>(s.ui.density, ["compact", "cozy", "comfortable"], "cozy"),
      );
      setAnimations(s.ui.animations);
      setAmbientLights(s.ui.ambientLights);
      setCustomThemesEnabled(s.ui.customThemesEnabled);
      setActiveCustomTheme(s.ui.activeCustomTheme);

      setEnableSpaces(s.workspace.enableSpaces);
      setEnableTags(s.workspace.enableTags);
      setNotificationsPanelDefault(s.workspace.notificationsPanelDefault);
      setDefaultView(
        validEnum<ProjectsView>(s.workspace.defaultView, ["cards", "list"], "cards"),
      );
      setDefaultSort(
        validEnum<ProjectsSort>(
          s.workspace.defaultSort,
          ["last-opened", "created", "name", "name-desc", "modified", "deadline", "format"],
          "last-opened",
        ),
      );
      setWidgetEnabled(s.workspace.widgets);
      setDashboardEnabled(s.workspace.dashboardEnabled);
      setDashboardOrder(s.workspace.dashboardOrder);
      setProjectCardWords(s.workspace.projectCardWords ?? false);
      if (s.workspace.statsCards?.length) setStatsCards(s.workspace.statsCards);

      if (s.integrations) {
        setIntegrationsSettings({ ...DEFAULT_INTEGRATIONS, ...s.integrations });
      }
    } catch {
      // First boot or non-Tauri context (Vitest).
      // On mobile first-boot, force the WASM engine since there's no system TeX.
      if (isTauriMobile()) setCompileEngine("texlive-wasm");
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
        dashboardEnabled: dashboardEnabled(),
        dashboardOrder: dashboardOrder(),
        projectCardWords: projectCardWords(),
        statsCards: statsCards(),
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
