import { createSignal } from "solid-js";
import type { SpaceDef } from "~/ipc";

export type ProjectsView = "cards" | "list";
export type ProjectsSort =
  | "last-opened"
  | "created"
  | "name"
  | "name-desc"
  | "modified"
  | "deadline"
  | "format";

// Spaces/Tags are real features (persisted per-project + a spaces catalog), so
// they default on. Users can still hide the sidebar sections in Settings.
const [enableSpaces, setEnableSpaces] = createSignal<boolean>(true);
const [enableTags, setEnableTags] = createSignal<boolean>(true);

/**
 * Named tint palette for spaces (and hashed tag colors). Ids, not raw colors,
 * so themes re-tint them; the render layer maps each to CSS vars.
 */
export const SPACE_TINTS = [
  "accent",
  "violet",
  "teal",
  "amber",
  "rose",
  "green",
  "slate",
] as const;
export type SpaceTint = (typeof SPACE_TINTS)[number];

/** Coerce an arbitrary persisted tint string to a known palette id. */
export function coerceSpaceTint(raw: string | undefined): SpaceTint {
  return (SPACE_TINTS as readonly string[]).includes(raw ?? "")
    ? (raw as SpaceTint)
    : "accent";
}

/**
 * The library spaces catalog (id + name + tint). Per-project membership lives
 * in each project's `space` field; this is just the set of defined spaces.
 * Persisted through settings-store under `workspace.spaces`.
 */
const [spaces, setSpaces] = createSignal<SpaceDef[]>([]);
const [notificationsPanelDefault, setNotificationsPanelDefault] =
  createSignal<boolean>(false);
const [defaultView, setDefaultView] = createSignal<ProjectsView>("cards");
const [defaultSort, setDefaultSort] =
  createSignal<ProjectsSort>("last-opened");

/**
 * Dashboard card enable map. Stored as a flat record keyed by card id;
 * missing entries fall back to the card's `defaultEnabled` in
 * `widgets/registry.ts`. (Persisted under the legacy `widgets` settings key.)
 */
const [widgetEnabled, setWidgetEnabled] = createSignal<Record<string, boolean>>(
  {},
);

const toggleWidget = (id: string, on?: boolean): void => {
  setWidgetEnabled((prev) => {
    const next = { ...prev };
    next[id] = on === undefined ? !next[id] : on;
    return next;
  });
};

/** Whether the Projects dashboard panel shows above the grid. Opt-in. */
const [dashboardEnabled, setDashboardEnabled] = createSignal<boolean>(false);

/**
 * User-arranged card order from drag & drop. Ids missing from this list
 * append in registry order; unknown ids are ignored at render time.
 */
const [dashboardOrder, setDashboardOrder] = createSignal<string[]>([]);

/** Show an approximate word count on each project card (reads root files). */
const [projectCardWords, setProjectCardWords] = createSignal<boolean>(false);

/**
 * Stat ids shown on the dashboard Statistics card. Loosely stored — the card
 * coerces unknown ids and caps the count against its stat catalog.
 */
const [statsCards, setStatsCards] = createSignal<string[]>([
  "latex",
  "typst",
  "deadlines",
  "overdue",
]);

export {
  dashboardEnabled,
  dashboardOrder,
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  projectCardWords,
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
  toggleWidget,
  widgetEnabled,
};
