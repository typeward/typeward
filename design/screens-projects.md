# Projects screen — Redesign spec

## Layout

```
┌──────────────────────────────────────────────────────────────────────┐
│                         [    search (centered)    ]   🔔  ⚙          │  top bar
├───────┬──────────────────────────────────────────────────┬───────────┤
│       │                                                  │           │
│ left  │              center (greeting + tools)           │   right   │
│ panel │                                                  │   panel   │
│       │                                                  │   (drawer)│
│       ├──────────────────────────────────────────────────┤           │
│       │              widget shelf (optional)             │           │
│       ├──────────────────────────────────────────────────┤           │
│       │                                                  │           │
│       │              project grid OR list                │           │
│       │                                                  │           │
│       │                                                  │           │
└───────┴──────────────────────────────────────────────────┴───────────┘
```

## Top bar

- **Remove** three traffic-light dots (Tauri owns window chrome already).
- **Remove** brand cluster: τ icon + "Typeward" name + version + "Marek Sokol
  Personal" workspace switcher pill.
- **Centered search** sized to align with the center column's edges. Width
  matches the center column.
- Right side: 🔔 notifications (toggles right panel), ⚙ settings. Icons sized
  larger than current (24px vs current 16px-ish).

## Left panel

- "Import" button at top (renamed from "Upload"). Same prominence as before;
  acts on local filesystem.
- "New project" button below, with platform-specific keyboard hint chips:
  - macOS: `⌘ N`
  - Windows / Linux: `Ctrl N`
  - Tablet: no hint chip
- Properly center icons in their gray rectangles (the current implementation
  has them slightly off — pure CSS fix).
- **Library / Spaces / Tags** sections. Spaces + Tags become opt-in via
  Settings → Workspace. When disabled, the section header + items don't render.
- **Remove** storage info card at the bottom.
- Keep the subscription status card (small footprint).

## Center column

### Toolbar row

```
[Widgets ▼]  [Sort ▼]      [Cards | List]
```

- **Widgets** button (replaces "Import" that was here): opens widget toggle
  dropdown.
- **Sort** menu: Name, Created, Last opened, Last modified, Format. Persists.
- **View toggle**: Cards (current grid) ↔ List (denser, single-line rows).

### Widget shelf

See [`widgets.md`](./widgets.md). Hidden by default.

### Project grid / list

Card view:

```
┌─────────────────────────────────┐
│ [LaTeX]            ★    ⋯       │   header row
│                                 │
│ Project title                   │
│ 12 pages · last opened 14d ago  │
│                                 │
│ main.tex                        │   footer mono
└─────────────────────────────────┘
```

- **Removed**: the document preview thumbnail with mock content. Cleaner cards,
  more cards fit per row.
- **Hover**: gradient-border animation + soft glow. CSS-only.
- Clicking opens the project (current behavior unchanged).

List view: same data, single row per project, dense (`--ui-row` height).

## Right panel — Notifications drawer

- **Hidden by default.** Bell icon in top-right toggles visibility.
- **Default visibility** is a setting (Settings → Workspace → "Show
  notifications panel by default").
- **Slide-in animation** from the right edge, 240ms cubic-bezier(0.2, 0.8, 0.2, 1).
  Respects the global animation toggle.
- **Content**: notifications only.
  - Inline alerts (compile failures across projects, sync conflicts, license
    renewals, app updates).
  - Mark-as-read + dismiss controls per item.
  - Header has "Mark all read" + "Settings" link.
- **Removed** from this panel: Focus checklist, Activity timeline (moved to
  widget shelf), Quick switcher (purpose served better by `Mod+K` palette).

## Removed elements summary

| Element | Why |
|---|---|
| Traffic-light dots | Tauri owns window chrome |
| Brand pill (τ + name + version) | Visual noise; brand lives in product, not chrome |
| Workspace switcher ("Marek Sokol · Personal") | Workspace concept deferred to Phase 4 |
| Project card preview thumbnail | Mock data; cleaner cards without it |
| Resume editing button | Click the project to open it — same outcome, fewer affordances |
| Storage info card | Premature; surface storage info when sync exists |
| Right-panel activity feed | Promoted to widget |
| Right-panel quick switcher | `Mod+K` palette covers it |
| Right-panel focus checklist | Out of scope for v0 |

## New settings surfaced

| Setting | Default | Section |
|---|---|---|
| Notifications panel visible by default | false | Workspace |
| Enable Spaces | true | Workspace |
| Enable Tags | true | Workspace |
| Widget enable map | `{ compose: true, recent: true }` | Workspace |
| Sort order | "last-opened" | Workspace |
| View mode | "cards" | Workspace |
