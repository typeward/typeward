/**
 * Event bridge between the main window and the detached PDF preview window
 * (E11). The main window owns all state (compiled PDF, review store, SyncTeX,
 * files); the preview window is a thin renderer. Traffic is Tauri events routed
 * by window label with `emitTo`, so neither window hears its own messages.
 *
 * Down (main → preview): full state snapshots + forward-search scroll targets.
 * Up (preview → main): a ready handshake plus user intents (recompile, inverse
 * search, open/create thread) that the main window services with its own logic.
 */
import { emitTo, listen, type UnlistenFn } from "@tauri-apps/api/event";
import { WebviewWindow, getAllWebviewWindows } from "@tauri-apps/api/webviewWindow";
import type { CreateThreadInput, PdfAnnotation } from "~/lib/pdf-annotations/types";
import { setPreviewDetached } from "~/stores/ui-store";

export const PREVIEW_LABEL = "preview";
export const MAIN_LABEL = "main";

const EV_STATE = "preview:state";
const EV_SCROLL = "preview:scroll";
const EV_UP = "preview:up";

/** Full render state pushed to the preview window on every change. */
export interface PreviewState {
  pdfPath: string | null;
  pdfVersion: number;
  compiling: boolean;
  theme: string;
  accent: string;
  annotations: PdfAnnotation[];
}

export interface PreviewScroll {
  page: number;
  y: number;
  generation: number;
}

/** Intents the preview window sends up for the main window to service. */
export type PreviewUp =
  | { type: "ready" }
  | { type: "recompile" }
  | { type: "inverse"; page: number; x: number; y: number; selectedText?: string }
  | { type: "openThread"; threadId: string }
  | { type: "createThread"; input: CreateThreadInput };

// ---- Main → Preview (down) ------------------------------------------------

export function sendPreviewState(state: PreviewState): void {
  // The window may have just closed — a rejected emit is not an error.
  void emitTo(PREVIEW_LABEL, EV_STATE, state).catch(() => {});
}

export function sendPreviewScroll(scroll: PreviewScroll): void {
  void emitTo(PREVIEW_LABEL, EV_SCROLL, scroll).catch(() => {});
}

export function listenPreviewState(cb: (s: PreviewState) => void): Promise<UnlistenFn> {
  return listen<PreviewState>(EV_STATE, (e) => cb(e.payload));
}

export function listenPreviewScroll(cb: (s: PreviewScroll) => void): Promise<UnlistenFn> {
  return listen<PreviewScroll>(EV_SCROLL, (e) => cb(e.payload));
}

// ---- Preview → Main (up) --------------------------------------------------

export function sendPreviewUp(msg: PreviewUp): void {
  void emitTo(MAIN_LABEL, EV_UP, msg).catch(() => {});
}

export function listenPreviewUp(cb: (m: PreviewUp) => void): Promise<UnlistenFn> {
  return listen<PreviewUp>(EV_UP, (e) => cb(e.payload));
}

// ---- Window lifecycle -----------------------------------------------------

export async function getPreviewWindow(): Promise<WebviewWindow | null> {
  const all = await getAllWebviewWindows();
  return (all.find((w) => w.label === PREVIEW_LABEL) as WebviewWindow) ?? null;
}

// At most one destroy listener may be armed at a time. `adoptExistingPreview`
// runs on every main-window (re)mount, so without this guard each editor->
// projects->editor navigation cycle would arm another once-listener on the same
// window. The destroy handler clears the flag so a later detach re-arms.
let destroyArmed = false;
function armDestroyListener(win: WebviewWindow): void {
  if (destroyArmed) return;
  destroyArmed = true;
  void win.once("tauri://destroyed", () => {
    destroyArmed = false;
    setPreviewDetached(false);
  });
}

/**
 * Open the detached preview window (or focus it if it already exists) and mark
 * the session detached. Wires the window's destroy event back to `previewDetached`
 * so closing it (the preview's Reattach button) restores the in-pane split.
 */
export async function detachPreview(): Promise<void> {
  const existing = await getPreviewWindow();
  if (existing) {
    await existing.unminimize().catch(() => {});
    await existing.setFocus().catch(() => {});
    setPreviewDetached(true);
    armDestroyListener(existing);
    return;
  }
  // A query param (not a router path) keeps the SPA/asset-protocol fallback
  // identical to the main window; index.tsx branches on it before importing App.
  const win = new WebviewWindow(PREVIEW_LABEL, {
    url: "index.html?window=preview",
    title: "Typeward — Preview",
    width: 900,
    height: 1100,
    minWidth: 400,
    minHeight: 400,
    resizable: true,
  });
  setPreviewDetached(true);
  // Roll back the optimistic flag if creation fails — Tauri surfaces this as a
  // `tauri://error` event (the constructor doesn't throw/reject), and without
  // this the in-pane preview would stay collapsed with no window and no way back.
  void win.once("tauri://error", () => setPreviewDetached(false));
  armDestroyListener(win);
}

/**
 * On main-window (re)mount, recover from an already-open preview window (HMR /
 * reload while detached): mark detached and re-arm the destroy listener.
 */
export async function adoptExistingPreview(): Promise<boolean> {
  const win = await getPreviewWindow();
  if (!win) return false;
  setPreviewDetached(true);
  armDestroyListener(win);
  return true;
}
