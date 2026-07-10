import { createSignal } from "solid-js";

import type { ChatMessage } from "~/integrations/types";

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
 * The navigate fn from @solidjs/router can only be obtained inside a Router
 * context. We capture it once on App mount (NavBootstrap) so module-level
 * actions can route the user without re-creating a hand-rolled router.
 */
let navigator: ((path: string) => void) | null = null;

export const paletteOpen_ = paletteOpen;
export const requestNewProject_ = requestNewProject;
export const requestSaveTemplate_ = requestSaveTemplate;
export const requestProDialog_ = requestProDialog;
export const requestHistoryPanel_ = requestHistoryPanel;
export const requestUpdateDialog_ = requestUpdateDialog;
export const requestAiAction_ = requestAiAction;

export const togglePalette = () =>
  setPaletteOpenInternal((v) => !v);

export const setPaletteOpen = (v: boolean) => setPaletteOpenInternal(v);

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

export const setNavigator = (fn: (path: string) => void) => {
  navigator = fn;
};

export const navigateTo = (path: string) => {
  if (navigator) navigator(path);
};
