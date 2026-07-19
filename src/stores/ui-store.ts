import { createEffect, createRoot, createSignal } from "solid-js";
import { THEME_ROSTER, theme } from "~/themes/theme-store";
import {
  paneTier,
  setActivePane,
  setLogsSheetOpen,
} from "~/stores/viewport-store";

export type Density = "compact" | "cozy" | "comfortable";
export const DENSITIES: readonly Density[] = ["compact", "cozy", "comfortable"];

/** Editor pane layout. `split` = files+editor+preview, `editor` = preview hidden, `preview` = editor hidden. */
export type EditorLayout = "split" | "editor" | "preview";

/** Where the logs/issues drawer lives. `drawer` = bottom strip; `pdf-tab` = tab inside the preview panel. */
export type ConsolePosition = "drawer" | "pdf-tab";

/** What the preview panel currently shows. `pdf` = compiled output, `console` = logs/issues, `ai` = AI chat. */
export type PreviewMode = "pdf" | "console" | "ai";

const [density, setDensity] = createSignal<Density>("cozy");
const [animations, setAnimations] = createSignal<boolean>(true);
const [ambientLights, setAmbientLights] = createSignal<boolean>(true);
/** Blend both accent stops across gradient surfaces. Off = solid accent-1. */
const [accentGradient, setAccentGradient] = createSignal<boolean>(true);
/** Accent glow behind primary buttons and card hovers. Only lands on styled
 * themes — basic themes force it off regardless of the setting. */
const [glowEffects, setGlowEffects] = createSignal<boolean>(true);
const [customThemesEnabled, setCustomThemesEnabled] = createSignal<boolean>(false);
const [activeCustomTheme, setActiveCustomTheme] =
  createSignal<string | null>(null);

const [editorLayout, setEditorLayout] = createSignal<EditorLayout>("split");
const [consolePosition, setConsolePosition] =
  createSignal<ConsolePosition>("pdf-tab");
const [previewMode, setPreviewMode] = createSignal<PreviewMode>("pdf");

/**
 * Persisted pane geometry (settings-store hydrates these on load and the
 * FieldSpecs write them back — see workspace.sidebarPx / workspace.centerSplit).
 * `sidebarPx` is null until the user drags the sidebar handle: while null the
 * sidebar keeps auto-fitting its tab strip (createSidebarResize's desiredPx),
 * and a persisted width would wrongly freeze that. `centerSplit` is the editor
 * panel's fraction of the editor/preview split — shared by the normal and
 * focus-mode layouts so a focus round-trip keeps the same split.
 */
const [sidebarPx, setSidebarPx] = createSignal<number | null>(null);
const [centerSplit, setCenterSplit] = createSignal<number>(0.55);

/**
 * Whether the PDF preview is showing in a separate OS window (E11). Session-
 * scoped: a restart brings the preview back into the split rather than
 * reopening a detached window. When true, the in-pane preview collapses and the
 * main window mirrors its state to the detached window over the event bridge.
 */
const [previewDetached, setPreviewDetached] = createSignal(false);

/**
 * Focus mode — hides editor chrome (top bar, sidebar, tab strip, toolbars)
 * leaving just source + page. Session-scoped on purpose: reopening the app
 * into hidden chrome would read as "the UI is broken".
 */
const [focusMode, setFocusMode] = createSignal(false);
const toggleFocusMode = (): void => {
  setFocusMode((v) => !v);
};

/**
 * One-shot intent to surface a specific Logs tab (e.g. the status-bar "N
 * problems" indicator raising the Grammar tab). The `generation` counter lets
 * consumers react to repeat requests for the same tab. Consumed by the
 * bottom LogsDrawer (select tab + un-minimize) and the in-preview LogsView
 * (switch the preview into console mode + select the tab).
 */
export interface LogsTabIntent {
  tab: string;
  generation: number;
}
const [logsTabIntent, setLogsTabIntentInternal] =
  createSignal<LogsTabIntent | null>(null);
let _logsTabGen = 0;
const requestLogsTab = (tab: string): void => {
  _logsTabGen++;
  setLogsTabIntentInternal({ tab, generation: _logsTabGen });
};

/**
 * Surface the compile Errors console from anywhere (status-bar indicator,
 * top-bar compile pill, PdfViewer's stale-preview hint). Lives here because
 * the routing depends on where the console is docked: the pdf-tab console
 * needs the preview pane visible (editor-only layout would hide it) and
 * switched into console mode before the tab intent can land.
 */
const revealCompileErrors = (): void => {
  // The ONE-pane tier renders a single pane: the drawer only exists inside
  // the (closed) LogsSheet and the pdf-tab console needs the preview pane
  // active. The two-pane tier (800-1023px) has no sheet and no pane switcher
  // — it routes like desktop (preview pane always rendered, drawer mounted).
  if (paneTier() === "one") {
    if (consolePosition() === "pdf-tab") {
      setActivePane("preview");
      setPreviewMode("console");
    } else {
      setLogsSheetOpen(true);
    }
    queueMicrotask(() => requestLogsTab("errors"));
    return;
  }
  if (consolePosition() === "pdf-tab") {
    if (editorLayout() === "editor") setEditorLayout("split");
    setPreviewMode("console");
    queueMicrotask(() => requestLogsTab("errors"));
  } else {
    requestLogsTab("errors");
  }
};

/**
 * One-shot intent from the tab-management commands (editor.closeTab /
 * nextTab / prevTab) and the macOS "Close Tab" menu item. The CenterPane in
 * text-shell consumes it so close funnels through the same dirty-confirm as
 * the tab strip's own close buttons. Mirrors the reviewPanelIntent pattern
 * (consumer clears); `generation` disambiguates repeat requests.
 */
export interface TabActionIntent {
  action: "close" | "next" | "prev";
  generation: number;
}
const [tabActionIntent, setTabActionIntent] =
  createSignal<TabActionIntent | null>(null);
let _tabActionGen = 0;
const requestTabAction = (action: TabActionIntent["action"]): void => {
  _tabActionGen++;
  setTabActionIntent({ action, generation: _tabActionGen });
};

if (typeof document !== "undefined") {
  createRoot(() => {
    createEffect(() => {
      document.documentElement.dataset.density = density();
    });
    createEffect(() => {
      document.documentElement.dataset.motion = animations()
        ? "full"
        : "reduced";
    });
    createEffect(() => {
      document.documentElement.dataset.ambient = ambientLights() ? "on" : "off";
    });
    createEffect(() => {
      document.documentElement.dataset.accentGradient = accentGradient()
        ? "on"
        : "off";
    });
    createEffect(() => {
      const styled = THEME_ROSTER[theme()].category === "styled";
      document.documentElement.dataset.glow =
        styled && glowEffects() ? "on" : "off";
    });
  });
}

export {
  accentGradient,
  activeCustomTheme,
  ambientLights,
  animations,
  centerSplit,
  consolePosition,
  customThemesEnabled,
  density,
  editorLayout,
  focusMode,
  glowEffects,
  logsTabIntent,
  previewDetached,
  previewMode,
  requestLogsTab,
  requestTabAction,
  revealCompileErrors,
  setAccentGradient,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setCenterSplit,
  setConsolePosition,
  setCustomThemesEnabled,
  setDensity,
  setEditorLayout,
  setFocusMode,
  setGlowEffects,
  setPreviewDetached,
  setPreviewMode,
  setSidebarPx,
  setTabActionIntent,
  sidebarPx,
  tabActionIntent,
  toggleFocusMode,
};
