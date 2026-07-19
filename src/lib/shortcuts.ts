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
  /** Literal Control key ("Ctrl+"), NOT folded into Mod — the physical Ctrl
   * key on every platform. Needed for bindings like Ctrl+Tab, where macOS
   * convention is Control (⌃), never ⌘. */
  ctrl: boolean;
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
  let ctrl = false;
  let shift = false;
  let alt = false;
  let key: string | null = null;
  for (const part of parts) {
    const lower = part.toLowerCase();
    if (lower === "mod" || lower === "cmd") {
      mod = true;
    } else if (lower === "ctrl" || lower === "control") {
      // Literal Control, distinct from Mod. Off-Mac the two land on the same
      // physical key (see `matches`); on Mac this is ⌃ while Mod is ⌘.
      ctrl = true;
    } else if (lower === "shift") {
      shift = true;
    } else if (lower === "alt" || lower === "option") {
      alt = true;
    } else {
      key = normalizeKey(part);
    }
  }
  if (!key) return null;
  return { mod, ctrl, shift, alt, key };
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
  if (isMac) {
    if (parsed.mod !== event.metaKey) return false;
    if (parsed.ctrl !== event.ctrlKey) return false;
  } else {
    // Off-Mac, Mod and literal Ctrl share the physical Control key — either
    // requirement (or both) resolves to ctrlKey.
    if ((parsed.mod || parsed.ctrl) !== event.ctrlKey) return false;
  }
  if (parsed.shift !== event.shiftKey) return false;
  if (parsed.alt !== event.altKey) return false;
  return normalizeKey(event.key) === parsed.key;
};

const KEY_DISPLAY: Record<string, string> = {
  enter: "↵",
  escape: "esc",
  tab: "Tab",
  arrowup: "↑",
  arrowdown: "↓",
  arrowleft: "←",
  arrowright: "→",
  " ": "Space",
};

// Mac glyphs follow the HIG menu order Control–Option–Shift–Command:
// ⌃⌥⇧⌘ with ⌘ last — "⇧⌘F", not "⌘⇧F". Non-Mac keeps the conventional
// Ctrl+Alt+Shift order (Mod and literal Ctrl both render "Ctrl" there,
// collapsed to one token when a binding carries both).
const modifierTokens = (parsed: ParsedShortcut): string[] => {
  const tokens: string[] = [];
  if (isMac) {
    if (parsed.ctrl) tokens.push("⌃");
    if (parsed.alt) tokens.push("⌥");
    if (parsed.shift) tokens.push("⇧");
    if (parsed.mod) tokens.push("⌘");
  } else {
    if (parsed.mod || parsed.ctrl) tokens.push("Ctrl");
    if (parsed.alt) tokens.push("Alt");
    if (parsed.shift) tokens.push("Shift");
  }
  return tokens;
};

/**
 * Render a shortcut as the human-facing string that goes inside <kbd>.
 * "Mod+K" → "⌘K" on Mac, "Ctrl+K" elsewhere.
 */
export const formatShortcutForDisplay = (shortcut: string): string => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return shortcut;
  const parts = modifierTokens(parsed);
  parts.push(KEY_DISPLAY[parsed.key] ?? parsed.key.toUpperCase());
  return isMac ? parts.join("") : parts.join("+");
};

/**
 * Split a shortcut into its individual key tokens so the palette can
 * render one <kbd> chip per token (matches the design files).
 */
export const shortcutTokens = (shortcut: string): string[] => {
  const parsed = parseShortcut(shortcut);
  if (!parsed) return [shortcut];
  const tokens = modifierTokens(parsed);
  tokens.push(KEY_DISPLAY[parsed.key] ?? parsed.key.toUpperCase());
  return tokens;
};
