import { createSignal } from "solid-js";

export type ProjectsView = "cards" | "list";
export type ProjectsSort = "last-opened" | "created" | "name" | "modified" | "format";

const [enableSpaces, setEnableSpaces] = createSignal<boolean>(true);
const [enableTags, setEnableTags] = createSignal<boolean>(true);
const [notificationsPanelDefault, setNotificationsPanelDefault] =
  createSignal<boolean>(false);
const [defaultView, setDefaultView] = createSignal<ProjectsView>("cards");
const [defaultSort, setDefaultSort] =
  createSignal<ProjectsSort>("last-opened");

/**
 * Widget enable map. Stored as a flat record keyed by widget id; missing
 * entries fall back to the widget's `defaultEnabled` in `widgets/registry.ts`.
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

export {
  defaultSort,
  defaultView,
  enableSpaces,
  enableTags,
  notificationsPanelDefault,
  setDefaultSort,
  setDefaultView,
  setEnableSpaces,
  setEnableTags,
  setNotificationsPanelDefault,
  setWidgetEnabled,
  toggleWidget,
  widgetEnabled,
};
