import { createSignal } from "solid-js";

/**
 * Command palette open-state lives in module scope so any action can flip it
 * regardless of which screen is mounted. The palette itself is rendered
 * once at the App root.
 */
const [paletteOpen, setPaletteOpenInternal] = createSignal(false);

/**
 * Signal-flagged "please open the new-project dialog" intent. ProjectsScreen
 * observes this — once it mounts (or if it's already mounted) it opens its
 * dialog and clears the flag. Lives here next to paletteOpen because the
 * command palette is the most common trigger.
 */
const [requestNewProject, setRequestNewProjectInternal] = createSignal(false);

/**
 * The navigate fn from @solidjs/router can only be obtained inside a Router
 * context. We capture it once on App mount (NavBootstrap) so module-level
 * actions can route the user without re-creating a hand-rolled router.
 */
let navigator: ((path: string) => void) | null = null;

export const paletteOpen_ = paletteOpen;
export const requestNewProject_ = requestNewProject;

export const togglePalette = () =>
  setPaletteOpenInternal((v) => !v);

export const setPaletteOpen = (v: boolean) => setPaletteOpenInternal(v);

export const setRequestNewProject = (v: boolean) =>
  setRequestNewProjectInternal(v);

export const setNavigator = (fn: (path: string) => void) => {
  navigator = fn;
};

export const navigateTo = (path: string) => {
  if (navigator) navigator(path);
};
