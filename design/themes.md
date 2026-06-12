# Themes

## Built-in themes

Exactly four themes since the 2026-06-11 "Desk Lamp" redesign.
**Daylight is the app default.**

| Theme | Base | Source design file | Notes |
|---|---|---|---|
| **Daylight** | light | `design_files/t1/Typeward.html` (light tokens) + `design_files/sample_identity.txt` / `sample.png` | **Default.** Warm ivory `#F8F4EA`, charcoal ink `#22211E`, near-black primary actions `#101210` (near-flat `.accent-grad` — "no loud gradients"), aged-brass `#B79A5C` text selection, seal-red `#A84935` errors, paper-gray `#D8D0C2` hairlines. No saturated tech colors in chrome; blue only in code syntax |
| **Lamplight** | dark | `design_files/t1/Typeward.html` (dark tokens) | The "lights out" room: warm black `#0D0C0A`, parchment text, amber `#E8A34D`, lamp-glow ambient |
| **Aurora** | dark | `tokens.css` defaults | Original violet/cyan glass aesthetic. Still the `:root` token baseline (no `data-theme` attribute) |
| **Paper** | light | `design_files/old/themes/Typeward Light.html` | Cool white/slate light theme |

Obsidian and Graphite were retired in the Desk Lamp redesign; the seven
community ports (Catppuccin, Dracula, Gruvbox, Mono, Nord, Solarized Light,
Tokyo Night) were removed the same day per user direction (HTML prototypes
remain in `design_files/old/themes/` if any ever come back). Persisted
selections of removed themes fall back to Daylight via `theme-store`'s
`read()` validation. `LIGHT_THEMES` in `theme-store.ts` lists the
light-surface themes for embedded-surface decisions (Markdown preview).

When custom themes are **enabled**, the built-in theme + accent pickers gray out
(per user spec). The first custom theme becomes the active one until the user
picks differently.

## Per-theme token groups

Beyond surface/fg tokens, every theme file defines:

- `--syntax-cmd/env/math/comment/bracket/attr` — CodeMirror highlight palette
  (`CodeMirror.tsx` reads these, so source colors re-skin per theme; the lamp
  themes use t1's code colors, light themes use deep variants).
- `--color-accent-fg` — text/icon color on accent surfaces. `.accent-grad`
  sets `color: var(--color-accent-fg)`: Daylight uses ivory on its ink
  button, Lamplight flips to ink on its light amber. Explicit `data-accent`
  palettes reset it to white.
- `--color-glass-soft-fill` — `.glass-soft` body tint (light themes invert it
  to a faint ink wash).
- `--color-text-selection` — CodeMirror + global `::selection` highlight.
  Defaults to an accent wash; Daylight overrides with brass so selection
  reads like a highlighter pass on paper (its ink accent would render gray).

## Display typography (added 2026-06-11, reverted same day)

A Source Serif 4 display-type pass (Library heading, onboarding headings,
dialog titles) was tried and **reverted per user direction** — the app is
all-Inter again. To re-apply: `npm i @fontsource/source-serif-4`, import
500/600 weights in `src/App.tsx`, add `--font-display: "Source Serif 4",
Georgia, "Times New Roman", serif;` to the tokens.css `@theme` block, and
put the `font-display` utility on: Projects "Library" h1, onboarding h1 +
pane h2s, the Dialog primitive title, and the NoProject card (bump each
1–2px — serifs run optically smaller than Inter).

## Accents

The first picker entry is **"Theme default"** — it removes `data-accent`, so
the active theme's native accent applies (brass on the lamp themes,
violet/cyan on Aurora). Three explicit palettes (Amber-Rose, Emerald-Teal,
Indigo-Pink) layer on top of any theme. Custom themes embed their own accent —
when a custom theme is selected, the accent picker is also grayed out.

## Custom themes — shipped 2026-06-12

User-defined themes are JSON files in `<app_data_dir>/themes/` — one file per
theme, the file stem is the theme id (letters, digits, `-`, `_`). The folder
is created on demand; Settings → Appearance → Custom themes has **Open
folder**, **Create sample**, and **Reload** buttons. The sample
(`harbor.json`, "Harbor" — a deep-sea teal dark theme on the Lamplight base)
is the working reference: it overrides every token group an author typically
wants.

### File format

```json
{
  "name": "Harbor",
  "base": "lamplight",
  "tokens": {
    "--color-bg-base": "#0b1418",
    "--color-accent-1": "#5ec4c0",
    "...": "any --token the built-in themes define"
  }
}
```

- `name` (required): display name, 1–64 chars.
- `base` (required): one of `daylight` / `lamplight` / `aurora` / `paper`.
  Every token the file doesn't override falls through to the base, and the
  base drives light/dark decisions downstream (Markdown preview prose, boot
  splash tint, shadow tokens).
- `tokens`: map of CSS custom property → value. Max 200 tokens; keys must
  match `--[a-z0-9-]+`; values are capped at 256 chars and reject `;{}<>\`
  (style-injection guard — see below).

### Loading & applying

- `custom_themes_list` IPC (`src-tauri/src/themes.rs`) scans the folder,
  validates each file, and returns themes + per-file warnings (typo'd token,
  bad base, symlink, oversized file). Warnings render in the Settings card so
  a broken file never silently disappears.
- The frontend runtime (`src/themes/custom-themes.ts`, mounted from
  `App.tsx` via `initCustomThemes()`) applies the active theme: it sets the
  built-in base via `setTheme(base)`, sets `data-custom-theme="<id>"` on
  `<html>`, and injects a `<style>` whose `html[data-custom-theme]` selector
  out-specifies the `[data-theme]` blocks.
- No file watcher — edits are picked up via the explicit **Reload** button
  (deliberate: a watcher on app_data is more machinery than the loop needs).
- If the active theme's file disappears, the base/built-in theme shows and
  the Settings card explains; the selection is kept in case the file returns.
- Persistence: `ui.customThemesEnabled` + `ui.activeCustomTheme` in
  settings.json. While a custom theme is active the built-in theme and accent
  pickers gray out (the theme embeds its own accent).

### Security note

Token values end up inside an injected style element, so Rust rejects values
containing `;` `{` `}` `<` `>` `\` or control characters and the frontend
re-checks before injection. The local user is trusted, but "paste this theme"
instructions floating around shouldn't become a CSS-injection vector.

### Authoring tips

- Start from the sample: Create sample → Open folder → copy `harbor.json`,
  rename it, recolor.
- Test against the editor screen first — it has the most surface variety.
- Foreground tokens (`--color-fg-1` … `--color-fg-4`) should monotonically
  descend in contrast against `--color-bg-base`. Skipping levels makes the UI
  feel patchy.
- Set `--color-accent-fg` whenever you change `--color-accent-1/2` — it's the
  text color sitting on accent surfaces, and an unreadable Recompile button is
  the most common authoring mistake.
