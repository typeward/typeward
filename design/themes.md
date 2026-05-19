# Themes

## Built-in themes

| Theme | Base | Source design file | Notes |
|---|---|---|---|
| **Aurora** | dark | `tokens.css` defaults | Original violet/cyan glass aesthetic |
| **Obsidian** | dark | `themes/obsidian.css` | Solid dark, no glass translucency |
| **Graphite** | dark | `themes/graphite.css` | Mid-gray with lighter fg |
| **Paper** | light | `design_files/themes/Typeward Light.html` | **Replaces** the existing `paper.css` styling with the Light prototype's values |
| **Catppuccin** | dark | `design_files/themes/Typeward Catppuccin.html` | Mocha variant; pastel pink/peach accents |
| **Dracula** | dark | `design_files/themes/Typeward Dracula.html` | Purple-pink accent |
| **Gruvbox** | dark | `design_files/themes/Typeward Gruvbox.html` | Warm earth tones |
| **Mono** | dark | `design_files/themes/Typeward Mono.html` | High-contrast monochrome |
| **Nord** | dark | `design_files/themes/Typeward Nord.html` | Cool blue |
| **Solarized Light** | light | `design_files/themes/Typeward Solarized Light.html` | Cream + selectivity |
| **Tokyo Night** | dark | `design_files/themes/Typeward Tokyo Night.html` | Indigo / electric blue |

When custom themes are **enabled**, the built-in theme + accent pickers gray out
(per user spec). The first custom theme becomes the active one until the user
picks differently.

## Accents

Four accent palettes (Violet-Cyan, Amber-Rose, Emerald-Teal, Indigo-Pink) layer
on top of any built-in theme. Custom themes embed their own accent — when a
custom theme is selected, the accent picker is also grayed out.

## Custom themes

User-defined themes live as JSON files in the app data directory:

```
<app_data_dir>/typeward/themes/
├── readme.txt        ← auto-generated explainer + token reference
├── neon-violet.json
└── solarized-mod.json
```

The folder is created on first boot. A `readme.txt` ships with the full token
reference so users know what's customizable.

### JSON schema

```json
{
  "$schema": "https://typeward.app/schemas/theme-v1.json",
  "name": "Neon Violet",
  "base": "dark",
  "tokens": {
    "--color-bg-base": "#0a0014",
    "--color-fg-1": "#f0e0ff",
    "--color-fg-2": "#a890c0",
    "--color-fg-3": "#806090",
    "--color-fg-4": "#503060",
    "--color-glass-fill": "rgb(255 255 255 / 0.035)",
    "--color-glass-stroke": "rgb(255 255 255 / 0.08)",
    "--color-accent-1": "#c026d3",
    "--color-accent-2": "#06b6d4",
    "--color-ok": "#10b981",
    "--color-warn": "#f59e0b",
    "--color-err": "#f43f5e"
  }
}
```

### Fields

- `name` (required, string): Display name. Must be unique across all theme JSONs.
- `base` (required, `"dark"` | `"light"`): Drives default shadow tokens + a few
  helpers that need to know whether the surface is light or dark.
- `tokens` (required, object): CSS custom property name → value. Any subset is
  fine; unspecified tokens fall through to `base` defaults (dark or paper).

### Loading

- Rust watches `<app_data_dir>/typeward/themes/` via the same `notify`-based
  watcher infrastructure used for projects (`src-tauri/src/watcher.rs`).
- On change, emit `themes-changed` event. Frontend `theme-store` rebuilds the
  custom theme list and re-applies the active theme if it was the one that
  changed.
- Validation: any malformed JSON is skipped with a telemetry warning. The
  active theme falls back to the default if the user's selection becomes
  invalid (e.g. they deleted the file).

### UI flow

In Settings → Appearance → Custom Themes:

1. Toggle: **Enable custom themes** (default off).
2. When on: built-in theme + accent grids gray out. Below them, a grid of
   discovered custom themes appears. Click to activate.
3. **Open themes folder** button (uses `tauri-plugin-shell` open) so users can
   add/edit files in their editor of choice.
4. **Reload** button forces a re-scan (in case the watcher missed something).

### Authoring tips (surfaced in `readme.txt`)

- Start by copying an existing built-in theme JSON (we ship them as references).
- Test against the editor screen first — that has the most surface variety.
- Foreground tokens (`--color-fg-1` … `--color-fg-4`) should monotonically
  descend in contrast against `--color-bg-base`. Skipping levels makes the UI
  feel patchy.
