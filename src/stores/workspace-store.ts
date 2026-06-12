import { createSignal } from "solid-js";

export type ProjectsView = "cards" | "list";
export type ProjectsSort = "last-opened" | "created" | "name" | "modified" | "format";

// Spaces/Tags render sample data until the real features land — opt-in only.
const [enableSpaces, setEnableSpaces] = createSignal<boolean>(false);
const [enableTags, setEnableTags] = createSignal<boolean>(false);
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

export {
  dashboardEnabled,
  dashboardOrder,
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  setDashboardEnabled,
  setDashboardOrder,
  setDefaultSort,
  setDefaultView,
  setEnableSpaces,
  setEnableTags,
  setNotificationsPanelDefault,
  setWidgetEnabled,
  toggleWidget,
  widgetEnabled,
};
