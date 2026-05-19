# Settings screen — Updates

## Card: Appearance

### Theme

Grid of built-in themes (Aurora, Obsidian, Graphite, Paper, Catppuccin,
Dracula, Gruvbox, Mono, Nord, Solarized Light, Tokyo Night).

### Accent

Existing 4 accent palettes.

### Custom themes (new)

Section below Accent:

- **Enable custom themes** switch (default off).
- When on:
  - Built-in theme + accent pickers **gray out** (still visible, just disabled).
  - Grid of custom themes discovered in `<app_data>/typeward/themes/*.json`
    appears. First custom theme is auto-selected on enable.
  - **Open themes folder** button → uses shell open to surface the directory.
  - **Reload** button → forces re-scan.
- Schema + workflow doc: [`themes.md`](./themes.md).

### Density (new)

Three radio cards: Compact, Cozy (default), Comfortable. See
[`density.md`](./density.md) for spec.

### Animations (new)

Single toggle: **Enable animations** (default on). See
[`motion.md`](./motion.md) for spec.

## Card: Editor

### Default engine

- Today: shows `system-tex`, `tectonic`, `busytex`.
- **Desktop**: `busytex` is hidden (it's a tablet fallback).
- **Tablet**: `busytex` is the only option (system-tex / tectonic can't run
  there). The whole "Default engine" section is replaced with a one-liner
  stating that busytex is the engine.

### Other editor settings (existing)

- Auto-compile, Vim mode, Spell check, Line wrap, Font size — unchanged.

## Card: Workspace (new section in nav)

Was buried in the projects sidebar; lift these into Settings:

- **Enable Spaces** switch (default on)
- **Enable Tags** switch (default on)
- **Notifications panel visible by default** switch (default off)
- **Default view** (Cards / List)
- **Default sort** (Last opened / Created / Name / Modified)

Widget enable map is **per-user storage**, not surfaced in Settings UI — users
toggle widgets via the Widgets dropdown on the Projects screen. Settings
exposes it only as a "Reset widgets" button next to a "Last changed N days ago"
hint.

## Card: Account / Billing / Integrations

Placeholders until Phase 4 (auth) lands. No change in this overhaul.

## Settings ↔ Editor round-trip

When entering Settings from the editor's gear icon:

1. Stash current route + project id in `nav-store.previousRoute`.
2. Settings screen shows a "Back" button (top-left) that reads this stash and
   navigates back. If empty, falls back to Projects.

Avoid `history.back()` — Tauri's history isn't reliable when the user has been
through several screens.

## Persistence

All new settings land in the existing `Settings` struct in
`src-tauri/src/settings.rs`. Defaults applied via serde `#[serde(default)]`
so users with older settings.json files don't break.

New shape:

```rust
pub struct Settings {
    pub theme: String,
    pub accent: String,
    pub editor: EditorSettings,
    pub projects_root: String,
    pub compile_engine: String,
    pub onboarded: bool,

    // new in this overhaul
    #[serde(default)]
    pub ui: UiSettings,
    #[serde(default)]
    pub workspace: WorkspaceSettings,
}

pub struct UiSettings {
    pub density: String,        // "compact" | "cozy" | "comfortable"
    pub animations: bool,
    pub custom_themes_enabled: bool,
    pub active_custom_theme: Option<String>,
}

pub struct WorkspaceSettings {
    pub enable_spaces: bool,
    pub enable_tags: bool,
    pub notifications_panel_default: bool,
    pub default_view: String,    // "cards" | "list"
    pub default_sort: String,    // "last-opened" | "created" | "name" | "modified"
    pub widgets: HashMap<String, bool>,
}
```
