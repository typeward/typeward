import { createEffect, createRoot, createSignal } from "solid-js";
import * as ipc from "~/ipc";
import { isTauriMobile } from "~/lib/platform";
import { isPreviewWindow } from "~/lib/window-role";
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
  accentGradient,
  activeCustomTheme,
  ambientLights,
  animations,
  customThemesEnabled,
  type Density,
  density,
  glowEffects,
  setAccentGradient,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setCustomThemesEnabled,
  setDensity,
  setGlowEffects,
} from "~/stores/ui-store";
import {
  coerceSpaceTint,
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
  setSpaces,
  setStatsCards,
  setWidgetEnabled,
  spaces,
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

export type LineHeightMode = "compact" | "normal" | "relaxed";

export interface EditorSettings {
  autoCompile: boolean;
  vimMode: boolean;
  lineWrap: boolean;
  fontSize: number;
  /** Pass -halt-on-error to latexmk/pdflatex (Tectonic always halts). */
  stopOnFirstError: boolean;
  lineNumbers: boolean;
  highlightActiveLine: boolean;
  autocomplete: boolean;
  bracketMatching: boolean;
  autoCloseBrackets: boolean;
  /** Editor indent width in spaces; one of 2/4/8. */
  tabSize: number;
  lineHeight: LineHeightMode;
  /** When on, the idle debounce writes the buffer to disk (a real save); when
   *  off, it only writes a crash-recovery snapshot. */
  autosaveEnabled: boolean;
  /** Autosave debounce in ms (frontend timer). */
  autosaveDelayMs: number;
  /** Default PDF zoom percentage the preview opens at. */
  pdfDefaultZoom: number;
  /** Invert the PDF (dark-mode reading) when a dark theme is active. */
  pdfInvertDark: boolean;
}

const DEFAULT_EDITOR: EditorSettings = {
  autoCompile: false,
  vimMode: false,
  lineWrap: true,
  fontSize: 13,
  stopOnFirstError: true,
  lineNumbers: true,
  highlightActiveLine: true,
  autocomplete: true,
  bracketMatching: true,
  autoCloseBrackets: true,
  tabSize: 2,
  lineHeight: "normal",
  autosaveEnabled: true,
  autosaveDelayMs: 500,
  pdfDefaultZoom: 110,
  pdfInvertDark: false,
};

/** Line-height multipliers for the three modes (consumed by CodeMirror). */
export const LINE_HEIGHT_VALUES: Record<LineHeightMode, string> = {
  compact: "1.5",
  normal: "1.65",
  relaxed: "1.85",
};

function clampNumber(raw: number, min: number, max: number, fallback: number): number {
  return typeof raw === "number" && Number.isFinite(raw)
    ? Math.min(max, Math.max(min, raw))
    : fallback;
}

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
// Egress opt-in: OFF by default — the Sentry SDK is never even fetched unless
// the user enables this (see src/lib/sentry-gate.ts).
const [shareCrashReports, setShareCrashReports] = createSignal<boolean>(false);
const [settingsLoaded, setSettingsLoaded] = createSignal<boolean>(false);

/**
 * One descriptor per persisted field. Each entry owns BOTH sides of the
 * roundtrip (`hydrate` on load, `serialize` on save) so the two lists can never
 * diverge — the historical failure mode where a field wired into load but
 * omitted from the save object literal loaded once and then silently stopped
 * persisting. Adding a persisted field is a single entry here (plus the owning
 * store's signal and the shared `ipc.AppSettings`/serde struct).
 */
interface FieldSpec {
  hydrate: (s: ipc.AppSettings) => void;
  serialize: (out: ipc.AppSettings) => void;
}

function field<T>(spec: {
  read: (s: ipc.AppSettings) => T;
  value: () => T;
  apply: (v: T) => void;
  write: (out: ipc.AppSettings, v: T) => void;
  validate?: (raw: T) => T;
}): FieldSpec {
  return {
    hydrate: (s) => {
      const raw = spec.read(s);
      spec.apply(spec.validate ? spec.validate(raw) : raw);
    },
    serialize: (out) => spec.write(out, spec.value()),
  };
}

const FIELDS: FieldSpec[] = [
  field<Theme>({
    read: (s) => s.theme as Theme,
    value: theme,
    apply: setTheme,
    write: (out, v) => {
      out.theme = v;
    },
    validate: (raw) => validEnum<Theme>(raw, THEMES, "daylight"),
  }),
  field<Accent>({
    read: (s) => s.accent as Accent,
    value: accent,
    apply: setAccent,
    write: (out, v) => {
      out.accent = v;
    },
    validate: (raw) => validEnum<Accent>(raw, ACCENTS, "violet-cyan"),
  }),
  field<EditorSettings>({
    // The IPC editor shape types lineHeight as a plain string; the validate
    // below narrows it back to LineHeightMode at the load boundary.
    read: (s) => s.editor as EditorSettings,
    value: editorSettings,
    apply: setEditorSettings,
    write: (out, v) => {
      out.editor = v;
    },
    // Merge over defaults (older settings.json predates the new fields) and
    // clamp the free-numeric/enum fields at the load boundary.
    validate: (raw) => {
      const merged = { ...DEFAULT_EDITOR, ...raw };
      return {
        ...merged,
        tabSize: [2, 4, 8].includes(merged.tabSize) ? merged.tabSize : 2,
        lineHeight: validEnum<LineHeightMode>(
          merged.lineHeight,
          ["compact", "normal", "relaxed"],
          "normal",
        ),
        autosaveDelayMs: clampNumber(merged.autosaveDelayMs, 200, 5000, 500),
        pdfDefaultZoom: clampNumber(merged.pdfDefaultZoom, 50, 300, 110),
      };
    },
  }),
  field<string>({
    read: (s) => s.projectsRoot,
    value: projectsRoot,
    apply: setProjectsRoot,
    write: (out, v) => {
      out.projectsRoot = v;
    },
  }),
  field<CompileEngine>({
    read: (s) => s.compileEngine as CompileEngine,
    value: compileEngine,
    apply: setCompileEngine,
    write: (out, v) => {
      out.compileEngine = v;
    },
    validate: migrateCompileEngine,
  }),
  field<boolean>({
    read: (s) => s.onboarded,
    value: onboarded,
    apply: setOnboarded,
    write: (out, v) => {
      out.onboarded = v;
    },
  }),
  // --- ui ---
  field<Density>({
    read: (s) => s.ui.density as Density,
    value: density,
    apply: setDensity,
    write: (out, v) => {
      out.ui.density = v;
    },
    validate: (raw) => validEnum<Density>(raw, ["compact", "cozy", "comfortable"], "cozy"),
  }),
  field<boolean>({
    read: (s) => s.ui.animations,
    value: animations,
    apply: setAnimations,
    write: (out, v) => {
      out.ui.animations = v;
    },
  }),
  field<boolean>({
    read: (s) => s.ui.ambientLights,
    value: ambientLights,
    apply: setAmbientLights,
    write: (out, v) => {
      out.ui.ambientLights = v;
    },
  }),
  field<boolean>({
    read: (s) => s.ui.accentGradient ?? true,
    value: accentGradient,
    apply: setAccentGradient,
    write: (out, v) => {
      out.ui.accentGradient = v;
    },
  }),
  field<boolean>({
    read: (s) => s.ui.glowEffects ?? true,
    value: glowEffects,
    apply: setGlowEffects,
    write: (out, v) => {
      out.ui.glowEffects = v;
    },
  }),
  field<boolean>({
    read: (s) => s.ui.customThemesEnabled,
    value: customThemesEnabled,
    apply: setCustomThemesEnabled,
    write: (out, v) => {
      out.ui.customThemesEnabled = v;
    },
  }),
  field<string | null>({
    read: (s) => s.ui.activeCustomTheme,
    value: activeCustomTheme,
    apply: setActiveCustomTheme,
    write: (out, v) => {
      out.ui.activeCustomTheme = v;
    },
  }),
  // --- workspace ---
  field<boolean>({
    read: (s) => s.workspace.enableSpaces,
    value: enableSpaces,
    apply: setEnableSpaces,
    write: (out, v) => {
      out.workspace.enableSpaces = v;
    },
  }),
  field<boolean>({
    read: (s) => s.workspace.enableTags,
    value: enableTags,
    apply: setEnableTags,
    write: (out, v) => {
      out.workspace.enableTags = v;
    },
  }),
  field<boolean>({
    read: (s) => s.workspace.notificationsPanelDefault,
    value: notificationsPanelDefault,
    apply: setNotificationsPanelDefault,
    write: (out, v) => {
      out.workspace.notificationsPanelDefault = v;
    },
  }),
  field<ProjectsView>({
    read: (s) => s.workspace.defaultView as ProjectsView,
    value: defaultView,
    apply: setDefaultView,
    write: (out, v) => {
      out.workspace.defaultView = v;
    },
    validate: (raw) => validEnum<ProjectsView>(raw, ["cards", "list"], "cards"),
  }),
  field<ProjectsSort>({
    read: (s) => s.workspace.defaultSort as ProjectsSort,
    value: defaultSort,
    apply: setDefaultSort,
    write: (out, v) => {
      out.workspace.defaultSort = v;
    },
    validate: (raw) =>
      validEnum<ProjectsSort>(
        raw,
        ["last-opened", "created", "name", "name-desc", "modified", "deadline", "format"],
        "last-opened",
      ),
  }),
  field<Record<string, boolean>>({
    read: (s) => s.workspace.widgets,
    value: widgetEnabled,
    apply: setWidgetEnabled,
    write: (out, v) => {
      out.workspace.widgets = v;
    },
  }),
  field<boolean>({
    read: (s) => s.workspace.dashboardEnabled,
    value: dashboardEnabled,
    apply: setDashboardEnabled,
    write: (out, v) => {
      out.workspace.dashboardEnabled = v;
    },
  }),
  field<string[]>({
    read: (s) => s.workspace.dashboardOrder,
    value: dashboardOrder,
    apply: setDashboardOrder,
    write: (out, v) => {
      out.workspace.dashboardOrder = v;
    },
  }),
  field<boolean>({
    read: (s) => s.workspace.projectCardWords ?? false,
    value: projectCardWords,
    apply: setProjectCardWords,
    write: (out, v) => {
      out.workspace.projectCardWords = v;
    },
  }),
  // statsCards keeps its default when the persisted list is absent/empty, so it
  // can't use the generic setter (which would clobber the default with []).
  {
    hydrate: (s) => {
      if (s.workspace.statsCards?.length) setStatsCards(s.workspace.statsCards);
    },
    serialize: (out) => {
      out.workspace.statsCards = statsCards();
    },
  },
  // spaces catalog: drop malformed entries (missing id/name) and coerce each
  // tint to a known palette id so a hand-edited settings.json can't render an
  // untinted/broken space.
  field<ipc.SpaceDef[]>({
    read: (s) => s.workspace.spaces ?? [],
    value: spaces,
    apply: setSpaces,
    write: (out, v) => {
      out.workspace.spaces = v;
    },
    validate: (raw) =>
      (Array.isArray(raw) ? raw : [])
        .filter(
          (sp) =>
            sp &&
            typeof sp.id === "string" &&
            sp.id.length > 0 &&
            typeof sp.name === "string" &&
            sp.name.length > 0,
        )
        .map((sp) => ({ id: sp.id, name: sp.name, tint: coerceSpaceTint(sp.tint) })),
  }),
  // integrations merges over defaults so a settings.json predating a provider
  // still gets its default block.
  {
    hydrate: (s) => {
      if (s.integrations) {
        setIntegrationsSettings({ ...DEFAULT_INTEGRATIONS, ...s.integrations });
      }
    },
    serialize: (out) => {
      out.integrations = integrationsSettings();
    },
  },
  // --- privacy ---
  field<boolean>({
    read: (s) => s.privacy?.shareCrashReports ?? false,
    value: shareCrashReports,
    apply: setShareCrashReports,
    write: (out, v) => {
      out.privacy = { shareCrashReports: v };
    },
  }),
];

/**
 * Pure builder for the persisted object — exported so a roundtrip test can
 * assert load→save symmetry without Tauri mocks. Top-level keys are pre-seeded
 * to keep the on-disk key order (and thus the change-detection JSON) stable.
 */
export function buildSettings(): ipc.AppSettings {
  const out = {
    theme: undefined,
    accent: undefined,
    editor: undefined,
    projectsRoot: undefined,
    compileEngine: undefined,
    onboarded: undefined,
    ui: {},
    workspace: {},
    integrations: undefined,
    privacy: undefined,
  } as unknown as ipc.AppSettings;
  for (const f of FIELDS) f.serialize(out);
  return out;
}

createRoot(() => {
  // Seeded from the just-loaded state so the persistence effect's first run
  // (triggered when `settingsLoaded` flips) is a no-op instead of echoing an
  // identical settings.json back to disk on every launch.
  let lastSavedJson: string | null = null;

  void (async () => {
    try {
      const s = await ipc.loadSettings();
      for (const f of FIELDS) f.hydrate(s);
      lastSavedJson = JSON.stringify(buildSettings());
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
    const next = buildSettings();
    if (!settingsLoaded()) return;
    // The detached preview window (E11) shares this bundle but holds a read-only
    // snapshot; letting it persist would clobber the main window's newer fields
    // (it only receives theme/accent over the bridge). Main window is the single
    // writer of settings.json.
    if (isPreviewWindow) return;
    const json = JSON.stringify(next);
    if (json === lastSavedJson) return;
    lastSavedJson = json;
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
  shareCrashReports,
  setCompileEngine,
  setEditorSettings,
  setIntegrationsSettings,
  setOnboarded,
  setProjectsRoot,
  setShareCrashReports,
};
