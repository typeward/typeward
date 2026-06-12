import { createEffect, createRoot, createSignal } from "solid-js";

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
const [customThemesEnabled, setCustomThemesEnabled] = createSignal<boolean>(false);
const [activeCustomTheme, setActiveCustomTheme] =
  createSignal<string | null>(null);

const [editorLayout, setEditorLayout] = createSignal<EditorLayout>("split");
const [consolePosition, setConsolePosition] =
  createSignal<ConsolePosition>("pdf-tab");
const [previewMode, setPreviewMode] = createSignal<PreviewMode>("pdf");

/**
 * Focus mode — hides editor chrome (top bar, sidebar, tab strip, toolbars)
 * leaving just source + page. Session-scoped on purpose: reopening the app
 * into hidden chrome would read as "the UI is broken".
 */
const [focusMode, setFocusMode] = createSignal(false);
const toggleFocusMode = (): void => {
  setFocusMode((v) => !v);
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
  });
}

export {
  activeCustomTheme,
  ambientLights,
  animations,
  consolePosition,
  customThemesEnabled,
  density,
  editorLayout,
  focusMode,
  previewMode,
  setActiveCustomTheme,
  setAmbientLights,
  setAnimations,
  setConsolePosition,
  setCustomThemesEnabled,
  setDensity,
  setEditorLayout,
  setFocusMode,
  setPreviewMode,
  toggleFocusMode,
};
