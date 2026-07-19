/**
 * Bridges the native macOS menu bar to the CommandRegistry. lib.rs's
 * `install_macos_menu` builds MenuItems whose ids are frontend command ids
 * and forwards any activated dotted id verbatim over the "menu:command"
 * event (the fallthrough arm in `on_menu_event`); this module listens and
 * runs the command through the same dispatch path as the palette and
 * keyboard router, so the three surfaces can never drift. The event is only
 * ever emitted on macOS, so mounting the bridge on every platform is
 * harmless — it just never fires.
 */
import type { EditorCommand } from "~/adapters/types";
import { cancelActiveCompile } from "~/commands/actions";
import { getCommand } from "~/commands/registry";
import { dispatchCommand } from "~/commands/run";

/**
 * "Compile" menu alias. Compile commands register per-format
 * (latex.compile / typst.compile) and only the open project's adapter is
 * live, so the menu carries one stable id and the bridge resolves it against
 * whichever candidate is currently registered.
 */
export const MENU_COMPILE_ID = "editor.compile";

/** Registry ids MENU_COMPILE_ID resolves to — at most one is live at a time. */
export const COMPILE_COMMAND_IDS: readonly string[] = ["latex.compile", "typst.compile"];

/**
 * "Stop Compile" menu alias. Cancel is deliberately not a registry command
 * (it's the compile-loop UI's stop button, not a palette entry), so the
 * bridge special-cases it straight to `cancelActiveCompile()`.
 */
export const MENU_STOP_COMPILE_ID = "editor.stopCompile";

/**
 * Every id `install_macos_menu` (src-tauri/src/lib.rs) can emit. Mirrors the
 * MenuItem ids there (cross-referenced); menu-bridge.test.ts asserts each
 * non-alias entry resolves to a registered command, so a renamed or deleted
 * command can't silently strand a menu item.
 */
export const MENU_COMMAND_IDS: string[] = [
  "core.newProject",
  "core.save",
  MENU_COMPILE_ID,
  MENU_STOP_COMPILE_ID,
  "latex.syncForward",
  "core.toggleFocusMode",
];

const resolveMenuCommand = (id: string): EditorCommand | undefined => {
  if (id === MENU_COMPILE_ID) {
    for (const candidate of COMPILE_COMMAND_IDS) {
      const cmd = getCommand(candidate);
      if (cmd) return cmd;
    }
    return undefined;
  }
  return getCommand(id);
};

/**
 * Run one menu activation. An unregistered id (Jump to PDF in a Typst
 * project) or a failed when-gate is a silent no-op — the correct menu
 * behavior for an inapplicable action. Scope is deliberately NOT checked:
 * the keyboard router's editor-focus gate keeps shortcuts from firing while
 * the user types in unrelated inputs, but a menu activation is an explicit
 * app-level intent (and on macOS the NSMenu accelerator swallowed the
 * keystroke anyway, so the router never gets a say).
 */
export function dispatchMenuCommand(id: string): void {
  if (id === MENU_STOP_COMPILE_ID) {
    void cancelActiveCompile();
    return;
  }
  const cmd = resolveMenuCommand(id);
  if (!cmd) return;
  if (cmd.when && !cmd.when()) return;
  dispatchCommand(cmd);
}

/**
 * Mounts the "menu:command" listener. Returns a teardown. Same
 * disposed-flag + dynamic-import pattern as the menu:close-tab listeners in
 * App.tsx / EditorScreen — the async listen can resolve after the caller
 * already tore down.
 */
export function installMenuBridge(): () => void {
  let disposed = false;
  let unlisten: (() => void) | undefined;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      const un = await listen<string>("menu:command", (e) => {
        if (typeof e.payload === "string") dispatchMenuCommand(e.payload);
      });
      if (disposed) un();
      else unlisten = un;
    } catch {
      /* non-Tauri context (vitest / plain-browser dev) — no native menu to bridge */
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = undefined;
  };
}
