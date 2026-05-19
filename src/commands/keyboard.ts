import { commands } from "./registry";
import { matches } from "~/lib/shortcuts";

/**
 * Decides whether an "editor"-scoped shortcut should fire. The user has the
 * editor focused if either:
 *   - the active element is inside a CodeMirror surface (`.cm-content`), OR
 *   - the active element is inside the editor screen layout (`[data-editor-shell]`)
 *
 * We don't want Mod+Enter compiling while the user types in a Settings
 * field, so editor-scoped commands check this gate.
 */
const editorHasFocus = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest(".cm-content")) return true;
  if (target.closest("[data-editor-shell]")) return true;
  // Fallback for keys hitting the body when no input is focused (e.g.,
  // right after a click on the editor pane).
  const active = document.activeElement;
  if (active instanceof Element) {
    if (active.closest(".cm-content")) return true;
    if (active.closest("[data-editor-shell]")) return true;
  }
  return false;
};

/**
 * Skip dispatch entirely when the user is typing into a non-editor input —
 * forms in Settings, the New Project name field, etc. CodeMirror's
 * contenteditable is *not* treated as an input here because we want
 * Mod+S / Mod+Enter to work while typing code.
 */
const isTypingInNonEditorInput = (target: EventTarget | null): boolean => {
  if (!(target instanceof Element)) return false;
  if (target.closest(".cm-content")) return false;
  const tag = target.tagName;
  if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return true;
  if (target instanceof HTMLElement && target.isContentEditable) return true;
  return false;
};

const handler = (event: KeyboardEvent) => {
  // The palette's own input field handles Escape natively via its onClose.
  // Don't double-dispatch Escape into command registry.
  for (const cmd of commands()) {
    if (!cmd.shortcut) continue;
    if (cmd.when && !cmd.when()) continue;

    const scope = cmd.scope ?? "global";
    if (scope === "editor" && !editorHasFocus(event.target)) continue;
    if (
      scope === "global" &&
      isTypingInNonEditorInput(event.target) &&
      // Mod+K should still fire from form fields — it's how users escape
      // typing back to navigation. Treat any Mod-combo as "wants to break
      // out of typing" and let it through.
      !(event.metaKey || event.ctrlKey)
    ) {
      continue;
    }

    if (!matches(event, cmd.shortcut)) continue;

    event.preventDefault();
    event.stopPropagation();
    void cmd.run();
    return;
  }
};

let installed = false;

/**
 * Mounts the global window keydown listener exactly once. Idempotent so
 * hot-reload doesn't double-bind.
 */
export const installGlobalShortcuts = (): void => {
  if (installed) return;
  installed = true;
  window.addEventListener("keydown", handler);
};

export const uninstallGlobalShortcuts = (): void => {
  if (!installed) return;
  installed = false;
  window.removeEventListener("keydown", handler);
};
