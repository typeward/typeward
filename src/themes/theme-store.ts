import { createEffect, createRoot, createSignal } from "solid-js";

export const THEMES = ["daylight", "lamplight", "aurora", "paper"] as const;
export type Theme = (typeof THEMES)[number];

export interface ThemeInfo {
  /** Display label. */
  label: string;
  /** Dark-surface theme — the single truth for every light/dark decision
   * (Markdown preview prose variant, Settings picker swatch). */
  dark: boolean;
}

/**
 * Single TS-side source of truth for the built-in theme roster. `Record<Theme>`
 * makes a missing entry a compile error, so THEME_LABEL / LIGHT_THEMES / the
 * Settings picker all derive from here rather than restating the roster.
 *
 * Three artifacts live OUTSIDE the bundle graph and cannot import this — they
 * must be edited in lockstep when a theme is added: the `@import` list in
 * `src/styles.css`, the SPLASH table in `public/boot-theme.js`, and
 * `BUILTIN_BASES` in `src-tauri/src/themes.rs`.
 */
export const THEME_ROSTER: Record<Theme, ThemeInfo> = {
  daylight: { label: "Daylight", dark: false },
  lamplight: { label: "Lamplight", dark: true },
  aurora: { label: "Aurora", dark: true },
  paper: { label: "Paper", dark: false },
};

/** Display labels for each built-in theme. Derived from {@link THEME_ROSTER}. */
export const THEME_LABEL: Record<Theme, string> = Object.fromEntries(
  THEMES.map((t) => [t, THEME_ROSTER[t].label]),
) as Record<Theme, string>;

/**
 * Light-surface themes — consulted when an embedded surface needs a
 * light/dark variant decision (e.g. the Markdown preview's prose theme).
 */
export const LIGHT_THEMES: readonly Theme[] = THEMES.filter(
  (t) => !THEME_ROSTER[t].dark,
);

export function isDarkTheme(t: Theme): boolean {
  return THEME_ROSTER[t].dark;
}

export const ACCENTS = [
  "violet-cyan",
  "amber-rose",
  "emerald-teal",
  "indigo-pink",
] as const;
export type Accent = (typeof ACCENTS)[number];

const STORAGE_KEY = "typeward.theme";

type Persisted = { theme: Theme; accent: Accent };

const DEFAULT: Persisted = { theme: "daylight", accent: "violet-cyan" };

function read(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      theme: THEMES.includes(parsed.theme as Theme)
        ? (parsed.theme as Theme)
        : DEFAULT.theme,
      accent: ACCENTS.includes(parsed.accent as Accent)
        ? (parsed.accent as Accent)
        : DEFAULT.accent,
    };
  } catch {
    return DEFAULT;
  }
}

const initial = read();
const [theme, setTheme] = createSignal<Theme>(initial.theme);
const [accent, setAccent] = createSignal<Accent>(initial.accent);

// Apply changes to <html> attributes and persist. The createRoot owner keeps
// the effect alive for the lifetime of the page (no disposal hook is needed —
// we want this to track for as long as the document is mounted).
createRoot(() => {
  createEffect(() => {
    const t = theme();
    const a = accent();
    const html = document.documentElement;
    if (t === "aurora") {
      html.removeAttribute("data-theme");
    } else {
      html.setAttribute("data-theme", t);
    }
    if (a === "violet-cyan") {
      html.removeAttribute("data-accent");
    } else {
      html.setAttribute("data-accent", a);
    }
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify({ theme: t, accent: a }));
    } catch {
      /* localStorage unavailable; ignore */
    }
  });
});

export { theme, setTheme, accent, setAccent };
