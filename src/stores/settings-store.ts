import { createEffect, createRoot, createSignal } from "solid-js";
import * as ipc from "~/ipc";
import { describeIpcError } from "~/lib/errors";
import { isTauriMobile } from "~/lib/platform";
import { recordError } from "~/lib/telemetry";
import { notifyError } from "~/lib/toast";
import { isPreviewWindow } from "~/lib/window-role";
import {
  ACCENTS,
  type Accent,
  THEME_SETTINGS,
  type ThemeSetting,
  accent,
  setAccent,
  setTheme,
  themeSetting,
} from "~/themes/theme-store";
import {
  accentGradient,
  activeCustomTheme,
  ambientLights,
  animations,
  centerSplit,
  type ConsolePosition,
  consolePosition,
  customThemesEnabled,
  type Density,
  density,
  type EditorLayout,
  editorLayout,
  glowEffects,
  setAccentGradient,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setCenterSplit,
  setConsolePosition,
  setCustomThemesEnabled,
  setDensity,
  setEditorLayout,
  setGlowEffects,
  setSidebarPx,
  sidebarPx,
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
import { isCoarsePointer } from "~/stores/viewport-store";

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
  /** Visual editing mode for LaTeX (.tex) — hidden-source WYSIWYG layer. */
  visualModeLatex: boolean;
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
  visualModeLatex: false,
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

/** Snap the interface scale onto the picker's 90–150 step-5 grid; anything
 * non-numeric lands back on 100 (the stylesheet default). */
function coerceUiScale(raw: number): number {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return 100;
  const clamped = Math.min(150, Math.max(90, raw));
  return Math.round(clamped / 5) * 5;
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
// Auto-update check on launch. ON by default — the check is a plain HTTPS GET
// to GitHub with no identifiers (see src/lib/updater.ts). Dormant regardless
// until an updater pubkey is configured.
const [updatesCheckAutomatically, setUpdatesCheckAutomatically] =
  createSignal<boolean>(true);
// "Sync settings across devices" (Settings → Account, shown only signed-in).
// Device-local: the toggle governs whether THIS machine participates, so it's
// denylisted from sync itself (settings-sync.ts). Default ON — signed-out
// users are unaffected because the engine only runs with a session.
const [syncSettingsEnabled, setSyncSettingsEnabled] = createSignal<boolean>(true);
// Local file-history retention (versions kept per file). Clamped 10–200 at the
// load boundary — mirrored by the Rust clamp in settings.rs, so the store and
// the recorder always agree on the bound.
const [historyMaxVersions, setHistoryMaxVersions] = createSignal<number>(50);
// Occasional in-app "give us feedback" card (feedback-prompt.ts). ON by
// default — the card is local UI and nothing leaves the machine unless the
// user presses Send, so it isn't an egress opt-in. Synced (a preference);
// the prompt's device-local pacing state lives in localStorage instead.
const [feedbackPromptsEnabled, setFeedbackPromptsEnabled] = createSignal<boolean>(true);
// Read-only mirror of privacy.installId: Rust mints it on the first crash
// report; the TS side only carries it through buildSettings() so a settings
// save can't clobber it. `noteInstallId` records an id minted mid-session
// (returned by the submit/scan IPCs after Rust persisted it).
const [installId, setInstallId] = createSignal<string | undefined>(undefined);
export function noteInstallId(id: string | null | undefined): void {
  if (id) setInstallId(id);
}
// Interface scale in percent (100 = 1.0). density.css wraps its px tokens in
// calc(<px> * var(--ui-scale, 1)); this store owns setting the variable on
// <html> (see the effect below the FIELDS list).
const [uiScale, setUiScale] = createSignal<number>(100);
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
  /**
   * Dotted settings.json path of this unit — also the row key used by
   * settings sync (settings-sync.ts), whose denylist classifies every key as
   * synced or device-local. A drift-guard test fails when a new entry is
   * neither.
   */
  key: string;
  hydrate: (s: ipc.AppSettings) => void;
  serialize: (out: ipc.AppSettings) => void;
}

function field<T>(spec: {
  key: string;
  read: (s: ipc.AppSettings) => T;
  value: () => T;
  apply: (v: T) => void;
  write: (out: ipc.AppSettings, v: T) => void;
  validate?: (raw: T) => T;
}): FieldSpec {
  return {
    key: spec.key,
    hydrate: (s) => {
      const raw = spec.read(s);
      spec.apply(spec.validate ? spec.validate(raw) : raw);
    },
    serialize: (out) => spec.write(out, spec.value()),
  };
}

const FIELDS: FieldSpec[] = [
  // Persists the theme SETTING — "system" stays "system" on disk; only the
  // <html data-theme> attribute carries the resolved concrete theme.
  field<ThemeSetting>({
    key: "theme",
    read: (s) => s.theme as ThemeSetting,
    value: themeSetting,
    apply: setTheme,
    write: (out, v) => {
      out.theme = v;
    },
    validate: (raw) => validEnum<ThemeSetting>(raw, THEME_SETTINGS, "daylight"),
  }),
  field<Accent>({
    key: "accent",
    read: (s) => s.accent as Accent,
    value: accent,
    apply: setAccent,
    write: (out, v) => {
      out.accent = v;
    },
    validate: (raw) => validEnum<Accent>(raw, ACCENTS, "violet-cyan"),
  }),
  field<EditorSettings>({
    key: "editor",
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
    key: "projectsRoot",
    read: (s) => s.projectsRoot,
    value: projectsRoot,
    apply: setProjectsRoot,
    write: (out, v) => {
      out.projectsRoot = v;
    },
  }),
  field<CompileEngine>({
    key: "compileEngine",
    read: (s) => s.compileEngine as CompileEngine,
    value: compileEngine,
    apply: setCompileEngine,
    write: (out, v) => {
      out.compileEngine = v;
    },
    validate: migrateCompileEngine,
  }),
  field<boolean>({
    key: "onboarded",
    read: (s) => s.onboarded,
    value: onboarded,
    apply: setOnboarded,
    write: (out, v) => {
      out.onboarded = v;
    },
  }),
  // --- ui ---
  field<Density>({
    key: "ui.density",
    read: (s) => s.ui.density as Density,
    value: density,
    apply: setDensity,
    write: (out, v) => {
      out.ui.density = v;
    },
    validate: (raw) => validEnum<Density>(raw, ["compact", "cozy", "comfortable"], "cozy"),
  }),
  field<number>({
    key: "ui.uiScale",
    read: (s) => s.ui.uiScale ?? 100,
    value: uiScale,
    apply: setUiScale,
    write: (out, v) => {
      out.ui.uiScale = v;
    },
    validate: coerceUiScale,
  }),
  field<boolean>({
    key: "ui.animations",
    read: (s) => s.ui.animations,
    value: animations,
    apply: setAnimations,
    write: (out, v) => {
      out.ui.animations = v;
    },
  }),
  field<boolean>({
    key: "ui.ambientLights",
    read: (s) => s.ui.ambientLights,
    value: ambientLights,
    apply: setAmbientLights,
    write: (out, v) => {
      out.ui.ambientLights = v;
    },
  }),
  field<boolean>({
    key: "ui.accentGradient",
    read: (s) => s.ui.accentGradient ?? true,
    value: accentGradient,
    apply: setAccentGradient,
    write: (out, v) => {
      out.ui.accentGradient = v;
    },
  }),
  field<boolean>({
    key: "ui.glowEffects",
    read: (s) => s.ui.glowEffects ?? true,
    value: glowEffects,
    apply: setGlowEffects,
    write: (out, v) => {
      out.ui.glowEffects = v;
    },
  }),
  field<boolean>({
    key: "ui.customThemesEnabled",
    read: (s) => s.ui.customThemesEnabled,
    value: customThemesEnabled,
    apply: setCustomThemesEnabled,
    write: (out, v) => {
      out.ui.customThemesEnabled = v;
    },
  }),
  field<string | null>({
    key: "ui.activeCustomTheme",
    read: (s) => s.ui.activeCustomTheme,
    value: activeCustomTheme,
    apply: setActiveCustomTheme,
    write: (out, v) => {
      out.ui.activeCustomTheme = v;
    },
  }),
  // --- workspace ---
  field<boolean>({
    key: "workspace.enableSpaces",
    read: (s) => s.workspace.enableSpaces,
    value: enableSpaces,
    apply: setEnableSpaces,
    write: (out, v) => {
      out.workspace.enableSpaces = v;
    },
  }),
  field<boolean>({
    key: "workspace.enableTags",
    read: (s) => s.workspace.enableTags,
    value: enableTags,
    apply: setEnableTags,
    write: (out, v) => {
      out.workspace.enableTags = v;
    },
  }),
  field<boolean>({
    key: "workspace.notificationsPanelDefault",
    read: (s) => s.workspace.notificationsPanelDefault,
    value: notificationsPanelDefault,
    apply: setNotificationsPanelDefault,
    write: (out, v) => {
      out.workspace.notificationsPanelDefault = v;
    },
  }),
  field<ProjectsView>({
    key: "workspace.defaultView",
    read: (s) => s.workspace.defaultView as ProjectsView,
    value: defaultView,
    apply: setDefaultView,
    write: (out, v) => {
      out.workspace.defaultView = v;
    },
    validate: (raw) => validEnum<ProjectsView>(raw, ["cards", "list"], "cards"),
  }),
  field<ProjectsSort>({
    key: "workspace.defaultSort",
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
    key: "workspace.widgets",
    read: (s) => s.workspace.widgets,
    value: widgetEnabled,
    apply: setWidgetEnabled,
    write: (out, v) => {
      out.workspace.widgets = v;
    },
  }),
  field<boolean>({
    key: "workspace.dashboardEnabled",
    read: (s) => s.workspace.dashboardEnabled,
    value: dashboardEnabled,
    apply: setDashboardEnabled,
    write: (out, v) => {
      out.workspace.dashboardEnabled = v;
    },
  }),
  field<string[]>({
    key: "workspace.dashboardOrder",
    read: (s) => s.workspace.dashboardOrder,
    value: dashboardOrder,
    apply: setDashboardOrder,
    write: (out, v) => {
      out.workspace.dashboardOrder = v;
    },
  }),
  field<boolean>({
    key: "workspace.projectCardWords",
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
    key: "workspace.statsCards",
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
    key: "workspace.spaces",
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
  // Editor pane geometry (audit #41): layout mode, console dock, sidebar
  // width, and the editor/preview split fraction survive a relaunch instead
  // of resetting to the Phase-E in-memory defaults.
  field<EditorLayout>({
    key: "workspace.editorLayout",
    read: (s) => (s.workspace.editorLayout ?? "split") as EditorLayout,
    value: editorLayout,
    apply: setEditorLayout,
    write: (out, v) => {
      out.workspace.editorLayout = v;
    },
    validate: (raw) =>
      validEnum<EditorLayout>(raw, ["split", "editor", "preview"], "split"),
  }),
  field<ConsolePosition>({
    key: "workspace.consolePosition",
    read: (s) => (s.workspace.consolePosition ?? "pdf-tab") as ConsolePosition,
    value: consolePosition,
    apply: setConsolePosition,
    write: (out, v) => {
      out.workspace.consolePosition = v;
    },
    validate: (raw) =>
      validEnum<ConsolePosition>(raw, ["drawer", "pdf-tab"], "pdf-tab"),
  }),
  // Nullable on purpose: null = the user never dragged the handle, so the
  // sidebar keeps auto-fitting its tab strip (createSidebarResize desiredPx).
  field<number | null>({
    key: "workspace.sidebarPx",
    read: (s) => s.workspace.sidebarPx ?? null,
    value: sidebarPx,
    apply: setSidebarPx,
    write: (out, v) => {
      out.workspace.sidebarPx = v;
    },
    validate: (raw) =>
      raw == null ? null : Math.round(clampNumber(raw, 200, 400, 300)),
  }),
  // Editor panel's fraction of the editor/preview split. The 0.3 floor
  // mirrors the panel's corvu minSize; the preview's 320px min re-clamps at
  // runtime, so the bound here only has to keep the value sane.
  field<number>({
    key: "workspace.centerSplit",
    read: (s) => s.workspace.centerSplit ?? 0.55,
    value: centerSplit,
    apply: setCenterSplit,
    write: (out, v) => {
      out.workspace.centerSplit = v;
    },
    validate: (raw) => clampNumber(raw, 0.3, 0.8, 0.55),
  }),
  // integrations merges over defaults so a settings.json predating a provider
  // still gets its default block.
  {
    key: "integrations",
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
  // Not the generic field() shape: privacy serializes as one object and must
  // preserve the Rust-owned installId alongside the user-facing toggle.
  {
    key: "privacy",
    hydrate: (s) => {
      setShareCrashReports(s.privacy?.shareCrashReports ?? false);
      setInstallId(s.privacy?.installId ?? undefined);
    },
    serialize: (out) => {
      const id = installId();
      out.privacy = {
        shareCrashReports: shareCrashReports(),
        ...(id ? { installId: id } : {}),
      };
    },
  },
  // --- updates ---
  field<boolean>({
    key: "updates.checkAutomatically",
    read: (s) => s.updates?.checkAutomatically ?? true,
    value: updatesCheckAutomatically,
    apply: setUpdatesCheckAutomatically,
    write: (out, v) => {
      out.updates = { checkAutomatically: v };
    },
  }),
  // --- sync ---
  field<boolean>({
    key: "sync.syncSettings",
    read: (s) => s.sync?.syncSettings ?? true,
    value: syncSettingsEnabled,
    apply: setSyncSettingsEnabled,
    write: (out, v) => {
      out.sync = { syncSettings: v };
    },
  }),
  // --- history ---
  field<number>({
    key: "history.maxVersionsPerFile",
    read: (s) => s.history?.maxVersionsPerFile ?? 50,
    value: historyMaxVersions,
    apply: setHistoryMaxVersions,
    write: (out, v) => {
      out.history = { maxVersionsPerFile: v };
    },
    validate: (raw) => clampNumber(raw, 10, 200, 50),
  }),
  // --- feedback ---
  field<boolean>({
    key: "feedback.promptsEnabled",
    read: (s) => s.feedback?.promptsEnabled ?? true,
    value: feedbackPromptsEnabled,
    apply: setFeedbackPromptsEnabled,
    write: (out, v) => {
      out.feedback = { promptsEnabled: v };
    },
  }),
];

// --ui-scale multiplies the density px tokens (density.css wraps each one in
// calc). At exactly 100 the property is removed so the stylesheet fallback
// (var(--ui-scale, 1)) applies untouched. Same document guard + page-lifetime
// root as ui-store's attribute effects.
if (typeof document !== "undefined") {
  createRoot(() => {
    createEffect(() => {
      const scale = uiScale();
      const style = document.documentElement.style;
      if (scale === 100) {
        style.removeProperty("--ui-scale");
      } else {
        style.setProperty("--ui-scale", String(scale / 100));
      }
    });
  });
}

// Once-flag for the density auto-default (design/density.md "Default per
// platform"): coarse-pointer devices start Comfortable, but only when the
// user has never chosen a density. There is no "was this explicit?" bit in
// settings.json, so a persisted value that differs from the "cozy" default
// counts as an explicit choice and just latches the flag.
const DENSITY_AUTO_APPLIED_KEY = "typeward.densityAutoApplied";

/**
 * An EXPLICIT density selection (Settings picker) permanently opts this
 * device out of the coarse-pointer auto-default — including choosing "cozy":
 * without the latch, an explicit cozy is indistinguishable from the untouched
 * default and a later first-coarse-mount (or a synced cozy landing from
 * another device) would override it to comfortable.
 */
export function latchDensityChoice(): void {
  if (typeof window === "undefined" || isPreviewWindow) return;
  try {
    window.localStorage.setItem(DENSITY_AUTO_APPLIED_KEY, "1");
  } catch {
    // Full/blocked storage: worst case the auto-default check reruns.
  }
}

function maybeAutoDefaultDensity(): void {
  // The preview window never persists settings and shares this localStorage
  // origin — latching the flag there would starve the main window's pass.
  if (typeof window === "undefined" || isPreviewWindow) return;
  try {
    if (window.localStorage.getItem(DENSITY_AUTO_APPLIED_KEY) !== null) return;
  } catch {
    // Without the once-guard readable, applying would repeat every launch
    // and clobber a later explicit "cozy" — skip entirely.
    return;
  }
  const latch = () => {
    try {
      window.localStorage.setItem(DENSITY_AUTO_APPLIED_KEY, "1");
    } catch {
      // Full/blocked storage: worst case the check reruns next launch.
    }
  };
  if (density() !== "cozy") {
    latch();
    return;
  }
  // Keyed on pointer coarseness, not viewport width — a landscape iPad is
  // 1133-1366 logical px and would never cross the 1024 width breakpoint.
  if (isCoarsePointer()) {
    setDensity("comfortable");
    latch();
  }
  // Fine pointer + untouched default: leave the flag unset so a first mount
  // on a touch device can still apply.
}

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
    updates: undefined,
    sync: undefined,
    history: undefined,
    feedback: undefined,
  } as unknown as ipc.AppSettings;
  for (const f of FIELDS) f.serialize(out);
  return out;
}

/**
 * Every persisted key, in FIELDS order — the classification universe for
 * settings sync (see SETTINGS_SYNC_DENYLIST in settings-sync.ts; a drift-guard
 * test asserts each key is either synced or denylisted).
 */
export const PERSISTED_SETTING_KEYS: readonly string[] = FIELDS.map((f) => f.key);

function setAtPath(obj: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let cursor = obj;
  for (const part of parts.slice(0, -1)) {
    const next = cursor[part];
    if (typeof next !== "object" || next === null) cursor[part] = {};
    cursor = cursor[part] as Record<string, unknown>;
  }
  cursor[parts[parts.length - 1]] = value;
}

/**
 * Apply a value pulled by settings sync through the same hydrate/validate
 * boundary as settings.json — remote values are the user's own data but may
 * come from a newer/older app version, so enum fallbacks, clamps, and
 * merge-over-defaults apply verbatim. Unknown keys (a newer build's fields)
 * are ignored. The value lands in a fresh `buildSettings()` snapshot, so the
 * field's `read` sees the rest of the settings tree exactly as persisted.
 */
export function applyRemoteSettingValue(key: string, value: unknown): boolean {
  const spec = FIELDS.find((f) => f.key === key);
  if (!spec) return false;
  const snapshot = buildSettings();
  setAtPath(snapshot as unknown as Record<string, unknown>, key, value);
  spec.hydrate(snapshot);
  return true;
}

function hasTauriIpc(): boolean {
  if (typeof window === "undefined") return false;
  return (
    typeof (window as Window & { __TAURI_INTERNALS__?: { invoke?: unknown } })
      .__TAURI_INTERNALS__?.invoke === "function"
  );
}

createRoot(() => {
  // Seeded from the just-loaded state so the persistence effect's first run
  // (triggered when `settingsLoaded` flips) is a no-op instead of echoing an
  // identical settings.json back to disk on every launch. Advanced only after
  // a write actually lands — advancing it eagerly made a failed write look
  // persisted, so nothing ever retried and the change was lost on quit.
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
      // After hydrate but before the persistence effect arms, so an applied
      // Comfortable lands in settings.json like any other change.
      maybeAutoDefaultDensity();
      setSettingsLoaded(true);
    }
  })();

  const SAVE_DEBOUNCE_MS = 250;
  // Slower than the debounce so a persistently failing write (disk full,
  // settings.json locked by another process) retries without hammering.
  // Doubles per consecutive failure up to the cap so a deterministic failure
  // can't flood the capped telemetry log or retry-spin forever at 2s.
  const SAVE_RETRY_MS = 2_000;
  const SAVE_RETRY_MAX_MS = 60_000;
  // Generous — a slow write that settles still counts as a success. Without
  // it, one invoke that never settles (AV/backup tool holding settings.json)
  // would hold the single-flight latch for the rest of the session and no
  // later change would ever persist.
  const SAVE_TIMEOUT_MS = 15_000;
  let saveTimer: ReturnType<typeof setTimeout> | null = null;
  let saveInFlight = false;
  // Toast and telemetry fire once per failure streak; a success resets both.
  let saveErrorNotified = false;
  let saveRetryDelay = SAVE_RETRY_MS;
  // Latest serialized state, refreshed on every effect run. The flush reads it
  // at fire time, so a retry (or a write queued behind an in-flight one) can
  // never resurrect a superseded snapshot.
  let latestSnapshot: { next: ipc.AppSettings; json: string } | null = null;

  function armSave(delay: number): void {
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(() => {
      saveTimer = null;
      void flushSave();
    }, delay);
  }

  function noteLateSaveSuccess(json: string): void {
    // Settlement order mirrors write-completion order, so a hung write that
    // succeeds after its timeout overwrote whatever a faster retry put on
    // disk in between — adopt it as the baseline and rewrite anything newer.
    lastSavedJson = json;
    saveErrorNotified = false;
    saveRetryDelay = SAVE_RETRY_MS;
    if (latestSnapshot !== null && latestSnapshot.json !== json) armSave(SAVE_DEBOUNCE_MS);
  }

  async function flushSave(): Promise<void> {
    // Single writer: if a write is in flight, its settle handler re-arms when
    // the store is still dirty.
    if (saveInFlight || latestSnapshot === null) return;
    const { next, json } = latestSnapshot;
    if (json === lastSavedJson) return;
    saveInFlight = true;
    let timedOut = false;
    let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
    const invoke = ipc.saveSettings(next);
    // A rejection landing after the timeout was already counted as a failure;
    // a success landing after it still reached disk and must not be lost.
    void invoke.then(
      () => {
        if (timedOut) noteLateSaveSuccess(json);
      },
      () => {},
    );
    let failed = false;
    try {
      await Promise.race([
        invoke,
        new Promise<never>((_resolve, reject) => {
          timeoutTimer = setTimeout(() => {
            timedOut = true;
            reject(
              new Error(`settings.json write did not settle within ${SAVE_TIMEOUT_MS / 1000}s`),
            );
          }, SAVE_TIMEOUT_MS);
        }),
      ]);
      saveErrorNotified = false;
      saveRetryDelay = SAVE_RETRY_MS;
    } catch (e) {
      // Outside Tauri (plain-browser dev, Vitest) there is no settings.json —
      // treat the write as done instead of retry-looping.
      if (hasTauriIpc()) {
        failed = true;
        if (!saveErrorNotified) {
          saveErrorNotified = true;
          recordError("settings-save", "writing settings.json failed", e);
          notifyError("Couldn't save settings", describeIpcError(e));
        }
      }
    } finally {
      clearTimeout(timeoutTimer);
    }
    saveInFlight = false;
    if (failed) {
      // Baseline untouched, so the store stays genuinely dirty — the re-armed
      // timer retries even if no further setting changes.
      armSave(saveRetryDelay);
      saveRetryDelay = Math.min(saveRetryDelay * 2, SAVE_RETRY_MAX_MS);
    } else {
      lastSavedJson = json;
      if (latestSnapshot.json !== json) armSave(SAVE_DEBOUNCE_MS);
    }
  }

  createEffect(() => {
    const next = buildSettings();
    if (!settingsLoaded()) return;
    // The detached preview window (E11) shares this bundle but holds a read-only
    // snapshot; letting it persist would clobber the main window's newer fields
    // (it only receives theme/accent over the bridge). Main window is the single
    // writer of settings.json.
    if (isPreviewWindow) return;
    const json = JSON.stringify(next);
    latestSnapshot = { next, json };
    if (json === lastSavedJson) return;
    // A fresh user change interrupts a failure backoff and retries promptly.
    saveRetryDelay = SAVE_RETRY_MS;
    armSave(SAVE_DEBOUNCE_MS);
  });
});

export {
  compileEngine,
  editorSettings,
  feedbackPromptsEnabled,
  historyMaxVersions,
  integrationsSettings,
  onboarded,
  projectsRoot,
  settingsLoaded,
  shareCrashReports,
  syncSettingsEnabled,
  uiScale,
  updatesCheckAutomatically,
  setCompileEngine,
  setEditorSettings,
  setFeedbackPromptsEnabled,
  setHistoryMaxVersions,
  setIntegrationsSettings,
  setOnboarded,
  setProjectsRoot,
  setShareCrashReports,
  setSyncSettingsEnabled,
  setUiScale,
  setUpdatesCheckAutomatically,
};
