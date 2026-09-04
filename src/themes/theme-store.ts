import { createEffect, createRoot, createSignal } from "solid-js";

import { isPreviewWindow } from "~/lib/window-role";

export const THEMES = [
  "light",
  "dark",
  "daylight",
  "lamplight",
  "aurora",
  "paper",
] as const;
export type Theme = (typeof THEMES)[number];

/**
 * The persistable theme choices: every concrete theme plus "system", which
 * follows the OS appearance (Daylight when light, Lamplight when dark).
 * "system" is a setting, not a theme — it never lands on `<html data-theme>`,
 * has no CSS block or boot-splash palette row of its own, and is NOT a valid
 * custom-theme base (`BUILTIN_BASES` in themes.rs stays concrete-only).
 */
export const THEME_SETTINGS = ["system", ...THEMES] as const;
export type ThemeSetting = (typeof THEME_SETTINGS)[number];

/** Picker grouping: plain neutral themes vs the stylized brand themes. */
export type ThemeCategory = "basic" | "styled";

export interface ThemeInfo {
  /** Display label. */
  label: string;
  /** Dark-surface theme — the single truth for every light/dark decision
   * (Markdown preview prose variant, Settings picker swatch). */
  dark: boolean;
  /** Which section of the Settings theme picker this belongs to. */
  category: ThemeCategory;
}

/**
 * Single TS-side source of truth for the built-in theme roster. `Record<Theme>`
 * makes a missing entry a compile error, so THEME_LABEL / LIGHT_THEMES / the
 * Settings picker all derive from here rather than restating the roster.
 *
 * Three artifacts live OUTSIDE the bundle graph and cannot import this — they
 * must be edited in lockstep when a theme is added: the `@import` list in
 * `src/styles.css`, the SPLASH table in `public/boot-theme.js`, and
 * `BUILTIN_BASES` in `src-tauri/src/themes.rs`. The "system" setting has a
 * fourth lockstep site: boot-theme.js re-implements resolveTheme's
 * daylight/lamplight mapping for the pre-bundle splash.
 */
export const THEME_ROSTER: Record<Theme, ThemeInfo> = {
  light: { label: "Light", dark: false, category: "basic" },
  dark: { label: "Dark", dark: true, category: "basic" },
  daylight: { label: "Daylight", dark: false, category: "styled" },
  lamplight: { label: "Lamplight", dark: true, category: "styled" },
  aurora: { label: "Aurora", dark: true, category: "styled" },
  paper: { label: "Paper", dark: false, category: "styled" },
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

type Persisted = { theme: ThemeSetting; accent: Accent };

const DEFAULT: Persisted = { theme: "daylight", accent: "violet-cyan" };

function read(): Persisted {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT;
    const parsed = JSON.parse(raw) as Partial<Persisted>;
    return {
      theme: THEME_SETTINGS.includes(parsed.theme as ThemeSetting)
        ? (parsed.theme as ThemeSetting)
        : DEFAULT.theme,
      accent: ACCENTS.includes(parsed.accent as Accent)
        ? (parsed.accent as Accent)
        : DEFAULT.accent,
    };
  } catch {
    return DEFAULT;
  }
}

// Guarded because jsdom's matchMedia support is minimal/absent — importing
// this store in Vitest must never throw. A missing API resolves "system" to
// light (daylight), matching the DEFAULT fallback.
const systemDarkQuery: MediaQueryList | null =
  typeof window !== "undefined" && typeof window.matchMedia === "function"
    ? window.matchMedia("(prefers-color-scheme: dark)")
    : null;
const [systemPrefersDark, setSystemPrefersDark] = createSignal<boolean>(
  systemDarkQuery?.matches ?? false,
);
systemDarkQuery?.addEventListener?.("change", (e) => {
  setSystemPrefersDark(e.matches);
});

/**
 * Resolve a persisted setting to the concrete theme to render. Reactive:
 * while the setting is "system" this tracks the OS appearance, so the app
 * re-tints live when the OS flips.
 */
export function resolveTheme(t: ThemeSetting): Theme {
  if (t !== "system") return t;
  return systemPrefersDark() ? "lamplight" : "daylight";
}

const initial = read();
const [themeSetting, setTheme] = createSignal<ThemeSetting>(initial.theme);
const [accent, setAccent] = createSignal<Accent>(initial.accent);

/**
 * The concrete theme in effect — what `<html data-theme>` carries and what
 * every light/dark branch (isDarkTheme, LIGHT_THEMES, swatch probes) reads.
 * The persisted choice, possibly "system", is {@link themeSetting}.
 */
const theme = (): Theme => resolveTheme(themeSetting());

// Apply changes to <html> attributes and persist. The createRoot owner keeps
// the effect alive for the lifetime of the page (no disposal hook is needed —
// we want this to track for as long as the document is mounted).
createRoot(() => {
  createEffect(() => {
    // Resolved theme on the attribute; the SETTING (possibly "system") in
    // storage, so boot-theme.js and the next launch re-resolve it fresh.
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
    // The detached preview window is a read-only theme consumer: it receives
    // the RESOLVED theme over the bridge and calls setTheme with it, and both
    // webviews share one origin — persisting from there would overwrite the
    // main window's "system" setting with a concrete theme.
    if (isPreviewWindow) return;
    try {
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({ theme: themeSetting(), accent: a }),
      );
    } catch {
      /* localStorage unavailable; ignore */
    }
  });
});

export { theme, themeSetting, setTheme, accent, setAccent };
