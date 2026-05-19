/**
 * Cross-platform keyboard shortcut helpers.
 *
 * Commands declare shortcuts in a normalized form like "Mod+S" or
 * "Mod+Shift+P". "Mod" resolves to ⌘ on Mac and Ctrl elsewhere — that lets
 * the same EditorCommand work on every platform without per-OS branches.
 */

export const isMac =
  typeof navigator !== "undefined" &&
  /Mac|iPhone|iPad|iPod/i.test(navigator.platform || navigator.userAgent || "");

interface ParsedShortcut {
  mod: boolean;
  shift: boolean;
  alt: boolean;
  /** Lowercased; "enter", "k", "/", etc. */
  key: string;
}

const KEY_ALIASES: Record<string, string> = {
  esc: "escape",
  escape: "escape",
  return: "enter",
  enter: "enter",
  space: " ",
};

const normalizeKey = (k: string): string => {
  const lower = k.toLowerCase();
  return KEY_ALIASES[lower] ?? lower;
};

const parseShortcut = (shortcut: string): ParsedShortcut | null => {
  const parts = shortcut.split("+").map((p) => p.trim());
  if (parts.length === 0) return null;
  let mod = false;
  let shift = false;
  let alt = false;
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmd" || lower === "ctrl" || lower === "control") {
      mod = true;
    } else if (lower === "shift") {
      shift = true;
    } else if (lower === "alt" || lower === "option") {
      alt = true;
    } else {
      key = normalizeKey(part);
    }
  }
  if (!key) return null;
  return { mod, shift, alt, key };
};

/**
 * Returns true if the given KeyboardEvent matches the shortcut. Mod is
 * Cmd on Mac and Ctrl elsewhere. We compare against the lowercased
 * `event.key`, which gives us locale-friendly behavior (Shift+/ → "?" still
 * matches "Mod+/" if shift is part of the binding).
 */
export const matches = (event: KeyboardEvent, shortcut: string): boolean => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return false;
  const modPressed = isMac ? event.metaKey : event.ctrlKey;
  if (parsed.mod !== modPressed) return false;
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  return normalizeKey(event.key) === parsed.key;
};

const KEY_DISPLAY: Record<string, string> = {
  enter: "↵",
  escape: "esc",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
};

/**
 * Render a shortcut as the human-facing string that goes inside <kbd>.
 * "Mod+K" → "⌘K" on Mac, "Ctrl+K" elsewhere.
 */
export const formatShortcutForDisplay = (shortcut: string): string => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;
  const parts: string[] = [];
  if (parsed.mod) parts.push(isMac ? "⌘" : "Ctrl");
  if (parsed.alt) parts.push(isMac ? "⌥" : "Alt");
  if (parsed.shift) parts.push(isMac ? "⇧" : "Shift");
  const keyDisplay = KEY_DISPLAY[parsed.key] ?? parsed.key.toUpperCase();
  parts.push(keyDisplay);
  return isMac ? parts.join("") : parts.join("+");
};

/**
 * Split a shortcut into its individual key tokens so the palette can
 * render one <kbd> chip per token (matches the design files).
 */
export const shortcutTokens = (shortcut: string): string[] => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return [shortcut];
  const tokens: string[] = [];
  if (parsed.mod) tokens.push(isMac ? "⌘" : "Ctrl");
  if (parsed.alt) tokens.push(isMac ? "⌥" : "Alt");
  if (parsed.shift) tokens.push(isMac ? "⇧" : "Shift");
  tokens.push(KEY_DISPLAY[parsed.key] ?? parsed.key.toUpperCase());
  return tokens;
};
