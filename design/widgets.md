# Widgets panel — Projects screen

> **Status: unmounted (2026-07-01).** The panel is removed from the Projects
> screen for now, per user direction — `ProjectsScreen` no longer renders
> `DashboardPanel` and the toolbar "Widgets" toggle is gone. The code under
> `src/widgets/` and all persisted settings (`workspace.dashboardEnabled`,
> `workspace.dashboardOrder`, `workspace.widgets`, `workspace.statsCards`)
> remain intact so it can be remounted without migration. The rest of this
> document describes the panel as it behaves when mounted.

> The panel is labelled **Widgets** in the UI (renamed from "Dashboard"
> 2026-06-14). Internal identifiers and persisted settings keys keep the
> `dashboard*` names (`DashboardPanel`, `workspace.dashboardEnabled`,
> `workspace.dashboardOrder`) to avoid breaking saved settings — only the
> visible label changed.

The center column on the Projects screen has an optional **Widgets** panel
above the toolbar. It replaced the free-floating widget shelf (2026-06-12):
instead of loose cards appearing when individually enabled, there is now one
cohesive panel the user turns on or off as a whole, with the cards living
inside it.

> History: the original layout had a full-width `ComposerHero` (AI compose
> preview + activity metrics) above the toolbar. That was deleted 2026-06-11
> (the library grid is the hero). The dashboard panel is its lightweight,
> opt-in successor — activity metrics without the AI composer.

## Activation

1. Click **Widgets** in the toolbar. The toggle persists
   (`workspace.dashboardEnabled`). When on, the panel renders **above** the
   toolbar (the Widgets/Sort/View controls), between the Library header and
   the toolbar — so the controls that govern it sit directly beneath it.
2. The panel renders every enabled card in the user's order. The panel's
   **Customize** menu toggles individual cards (persisted under the legacy
   `workspace.widgets` map). No card is forced-on; if all are off, the panel
   shows a hint to enable some.
3. The panel's **×** hides the whole thing again.

## Layout & interaction

- One `glass-soft` container with a header row (label · "drag cards to
  rearrange" hint · Customize · ×).
- Cards are 236px-tall `card-bg-soft` tiles; desktop lays them out in an
  auto-fill grid (`minmax(260px, 1fr)`), tablet stacks them vertically. The
  height was bumped from 190px (2026-06-14) so the heatmap, calendar, and stat
  tiles aren't compressed.
- **Drag & drop reorder**: cards reorder via a **pointer-based** drag on the
  grip handle (`setPointerCapture` + `document.elementFromPoint` to find the
  card under the cursor, live-swapping order on move). This replaced HTML5
  drag-and-drop, which was unreliable inside the webview and gave no touch
  support — the pointer approach works on desktop and tablet alike. Order
  persists as `workspace.dashboardOrder` (unknown ids ignored, new cards
  append in registry order). Every card is a registered widget — there's no
  special always-on card.
- **Responsive layout**: desktop renders the cards in an auto-fill grid
  (`minmax(260px, 1fr)`) that reflows by width; tablet stacks them vertically.
  Card internals (heatmap, chart, calendar) fill the card width.

## Cards

| Card | Description | Status |
|---|---|---|
| **Overview** | Project count, per-format chips, "Continue <last project>" jump-back button. Was the fixed "Activity" card until 2026-06-14 — now a normal toggleable/reorderable widget (id `overview`), renamed to avoid colliding with the Activity graph card. | shipped |
| **Recent projects** | Last 5 projects, click to open. | shipped |
| **Statistics** | 2×2 stat tiles, user-picked (up to 4) from a catalog via the card's Customize popover: total, LaTeX, Typst, deadlines, overdue, due-in-7d, active-7d, active-30d, new-this-month, git repos, cloud-synced. Selection persists as `workspace.statsCards`. | shipped |
| **Activity** (graph) | GitHub-style contribution heatmap over the last 17 weeks (spans the full card width), toggleable to a weekly bar chart. Both views carry month labels along the bottom. One activity point per project on its created day + its modified day. | shipped |
| **Deadlines** | Mini month calendar (prev/next nav) that flexes to fit, with deadline days highlighted; click a marked day to open the project; a divided footer shows the next due deadline. | shipped |
| **Pinned notes** | Editable scratchpad, persisted in localStorage. | shipped |

The **Focus timer** (Pomodoro) card was removed 2026-06-14 in favour of the
Statistics / Activity-graph / Deadlines cards above.

Deadlines come from the per-project `deadline` field (ISO `YYYY-MM-DD`) in
`project.json`, set via the date picker in the New-project dialog or the
deadline chip on each project card. Created/modified timestamps used by the
Statistics + Activity cards (and the date sorts) are filesystem mtimes
attached by `list_projects` (the `ProjectListing` shape), never persisted.

The whole panel is off by default (`workspace.dashboardEnabled` is `false` in
both the store and the Rust settings default), so the Projects screen shows no
widgets until the user clicks **Widgets** in the toolbar. Once enabled, all
registered cards default to on, so first activation shows a full panel rather
than an empty strip.

## Card contract

Cards register through `src/widgets/registry.ts` (unchanged `WidgetDef`
interface; the dashboard reads the same registry the shelf did):

```ts
interface WidgetDef {
  id: string;                   // stable, used in settings persistence
  title: string;
  description: string;          // shown in the Customize menu
  defaultEnabled: boolean;
  icon: (size?: number) => JSX.Element;
  Render: Component;            // body only; the panel provides card chrome
  order: number;                // fallback order before the user drags
}
```

Implementation: `src/widgets/DashboardPanel.tsx` (panel + Activity card +
Customize menu + DnD), `src/widgets/builtins.tsx` (card catalog).
`WidgetsShelf.tsx` / `WidgetsMenu.tsx` were deleted with the shelf.

## Persistence

| Key (settings.json `workspace`) | Meaning |
|---|---|
| `dashboardEnabled` | Panel on/off (default off) |
| `dashboardOrder` | User-arranged card id order (includes `__activity__`) |
| `widgets` | Per-card enable map (legacy name kept so pre-dashboard toggles carry over) |
| `projectCardWords` | Show an approximate word count on each project card (default off; reads each root file). Toggle in Settings → Workspace. |
| `statsCards` | Stat ids shown on the Statistics card (default `latex,typst,deadlines,overdue`). Picked in the card's Customize popover; coerced/capped to 4 known ids on read. |
