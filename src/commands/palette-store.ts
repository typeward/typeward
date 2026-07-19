import { createSignal } from "solid-js";

import type { ChatMessage } from "~/integrations/types";
import { registerCommand } from "./registry";
import { project } from "~/stores/editor-store";

/**
 * Command palette open-state lives in module scope so any action can flip it
 * regardless of which screen is mounted. The palette itself is rendered
 * once at the App root.
 */
const [paletteOpen, setPaletteOpenInternal] = createSignal(false);

/**
 * One-shot query the palette adopts on its next open (quick-open prefills
 * "file:"). Non-reactive on purpose — the palette consumes it inside its
 * open effect; `paletteSeedGeneration` only exists so seeding an
 * ALREADY-open palette still re-runs that consumption.
 */
let pendingSeedQuery: string | null = null;
const [paletteSeedGeneration, setPaletteSeedGeneration] = createSignal(0);

/**
 * MRU of command ids the user ran FROM the palette (not keyboard shortcuts —
 * recents exist to shortcut repeat palette trips). Persisted so the
 * "Recently used" group survives restarts.
 */
const RECENTS_KEY = "typeward.palette-recents";
const RECENTS_MAX = 8;

function loadRecents(): string[] {
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(RECENTS_KEY) ?? "[]");
    return Array.isArray(parsed)
      ? parsed.filter((v): v is string => typeof v === "string").slice(0, RECENTS_MAX)
      : [];
  } catch {
    return [];
  }
}

const [recentCommandIds, setRecentCommandIds] = createSignal<string[]>(loadRecents());

/**
 * Signal-flagged "please open the new-project dialog" intent. ProjectsScreen
 * observes this — once it mounts (or if it's already mounted) it opens its
 * dialog and clears the flag. Lives here next to paletteOpen because the
 * command palette is the most common trigger.
 */
const [requestNewProject, setRequestNewProjectInternal] = createSignal(false);

/**
 * "Please open the Save-as-Template dialog" intent. The dialog is rendered
 * once at the App root and observes this flag; the editor's "Save project as
 * template" command flips it.
 */
const [requestSaveTemplate, setRequestSaveTemplateInternal] = createSignal(false);

/**
 * "Please open the What's-in-Pro dialog" intent. Raised by the
 * `core.whatsInPro` command and by every locked Pro affordance (chips,
 * locked panels); the dialog is rendered once at the App root.
 */
const [requestProDialog, setRequestProDialogInternal] = createSignal(false);

/**
 * "Please open the History sidebar tab" intent. Raised by the
 * `core.fileHistory` command; the editor shell owns the sidebar tab state and
 * observes this (same shape as the review-panel intent).
 */
const [requestHistoryPanel, setRequestHistoryPanelInternal] = createSignal(false);

/** Metadata for the non-modal "update available" dialog. The pending plugin
 *  `Update` handle stays in updater.ts; only display data crosses here. */
export interface UpdatePromptInfo {
  version: string;
  currentVersion: string;
  notes: string;
  date?: string;
}

/**
 * "An update is available" intent. Raised by src/lib/updater.ts when a check
 * finds a newer version; the dialog is lazy-mounted once at the App root
 * (same request-signal pattern as ProDialog). `null` = closed.
 */
const [requestUpdateDialog, setRequestUpdateDialogInternal] =
  createSignal<UpdatePromptInfo | null>(null);

/**
 * One transform/continue AI editor action to run in the lazy `AiActionDialog`
 * (mounted at App root). The selection snapshot is captured at invoke time —
 * Replace re-verifies it against the live document before dispatching.
 */
export interface AiActionRequestInfo {
  actionId: string;
  kind: "transform" | "continue";
  label: string;
  /** The exact outbound message list (assembled + capped in context.ts). */
  messages: ChatMessage[];
  snapshot: { from: number; to: number; text: string };
  /**
   * Pre-computed result (chat bubble "Apply to selection") — the dialog
   * skips streaming and goes straight to the diff preview. Nothing is sent.
   */
  presetResult?: string;
  generation: number;
}

/**
 * "Run this AI action" intent. Raised by `integrations/ai/actions.ts` from
 * the palette commands and editor context-menu items. `null` = closed.
 */
const [requestAiAction, setRequestAiActionInternal] =
  createSignal<AiActionRequestInfo | null>(null);

/**
 * "Open the feedback card" intent (lazy-mounted once at the App root).
 * "prompted" = raised by the occasional trigger engine (feedback-prompt.ts;
 * dismissals count toward its cap); "manual" = the core.sendFeedback command,
 * which ignores and never consumes trigger state. `null` = closed.
 */
export type FeedbackCardMode = "prompted" | "manual";
const [requestFeedbackCard, setRequestFeedbackCardInternal] =
  createSignal<FeedbackCardMode | null>(null);

/**
 * The navigate fn from @solidjs/router can only be obtained inside a Router
 * context. We capture it once on App mount (NavBootstrap) so module-level
 * actions can route the user without re-creating a hand-rolled router.
 */
let navigator: ((path: string) => void) | null = null;

export const paletteOpen_ = paletteOpen;
export const paletteSeedGeneration_ = paletteSeedGeneration;
export const recentCommandIds_ = recentCommandIds;
export const requestNewProject_ = requestNewProject;
export const requestSaveTemplate_ = requestSaveTemplate;
export const requestProDialog_ = requestProDialog;
export const requestHistoryPanel_ = requestHistoryPanel;
export const requestUpdateDialog_ = requestUpdateDialog;
export const requestAiAction_ = requestAiAction;
export const requestFeedbackCard_ = requestFeedbackCard;

export const togglePalette = () =>
  setPaletteOpenInternal((v) => !v);

export const setPaletteOpen = (v: boolean) => setPaletteOpenInternal(v);

/**
 * Open the palette with a prefilled query. The generation bump fires first so
 * an already-open palette (whose open state won't change) still adopts the
 * seed via its generation effect; on a fresh open the palette's open effect
 * consumes the pending value before that effect sees it.
 */
export const openPaletteWithQuery = (query: string) => {
  pendingSeedQuery = query;
  setPaletteSeedGeneration((n) => n + 1);
  setPaletteOpenInternal(true);
};

/** Consume the pending seed query (one-shot). `null` = nothing seeded. */
export const takePaletteSeedQuery = (): string | null => {
  const q = pendingSeedQuery;
  pendingSeedQuery = null;
  return q;
};

/** Move a palette-dispatched command to the front of the recents MRU. */
export const noteRecentCommand = (id: string): void => {
  const next = [id, ...recentCommandIds().filter((x) => x !== id)].slice(
    0,
    RECENTS_MAX,
  );
  setRecentCommandIds(next);
  try {
    localStorage.setItem(RECENTS_KEY, JSON.stringify(next));
  } catch {
    // Storage full/unavailable — recents just won't survive this session.
  }
};

// Registered here rather than boot.ts: quick-open is palette behavior (it IS
// the palette in file mode), and the registry auto-binds the shortcut through
// the global keyboard router either way.
registerCommand({
  id: "core.quickOpen",
  title: "Go to file",
  subtitle: "Jump to any text file in the open project",
  shortcut: "Mod+P",
  group: "Navigation",
  scope: "global",
  // project() outlives the editor screen (it isn't cleared on navigate), so
  // gate on the editor actually being mounted — a goto intent raised from the
  // Projects/Settings screens has no consumer and would apply on a later
  // mount as a stale surprise. Same marker the keyboard router scopes on.
  when: () =>
    project() !== null && document.querySelector("[data-editor-shell]") !== null,
  run: () => {
    openPaletteWithQuery("file:");
  },
});

export const setRequestNewProject = (v: boolean) =>
  setRequestNewProjectInternal(v);

export const setRequestSaveTemplate = (v: boolean) =>
  setRequestSaveTemplateInternal(v);

export const setRequestProDialog = (v: boolean) =>
  setRequestProDialogInternal(v);

export const setRequestHistoryPanel = (v: boolean) =>
  setRequestHistoryPanelInternal(v);

export const setRequestUpdateDialog = (v: UpdatePromptInfo | null) =>
  setRequestUpdateDialogInternal(v);

export const setRequestAiAction = (v: AiActionRequestInfo | null) =>
  setRequestAiActionInternal(v);

export const setRequestFeedbackCard = (v: FeedbackCardMode | null) =>
  setRequestFeedbackCardInternal(v);

export const setNavigator = (fn: (path: string) => void) => {
  navigator = fn;
};

export const navigateTo = (path: string) => {
  if (navigator) navigator(path);
};
