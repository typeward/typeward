# Dashboard panel — Projects screen

The center column on the Projects screen has an optional **Dashboard** panel
between the toolbar and the project grid. It replaced the free-floating
widget shelf (2026-06-12): instead of loose cards appearing when individually
enabled, there is now one cohesive panel the user turns on or off as a whole,
with the cards living inside it.

> History: the original layout had a full-width `ComposerHero` (AI compose
> preview + activity metrics) above the toolbar. That was deleted 2026-06-11
> (the library grid is the hero). The dashboard panel is its lightweight,
> opt-in successor — activity metrics without the AI composer.

## Activation

1. Click **Dashboard** in the toolbar (leftmost, replaces the old Widgets
   dropdown). The toggle persists (`workspace.dashboardEnabled`).
2. The panel renders a fixed **Activity** card first, then every enabled
   card. The panel's **Customize** menu toggles individual cards
   (persisted under the legacy `workspace.widgets` map).
3. The panel's **×** hides the whole thing again.

## Layout & interaction

- One `glass-soft` container with a header row (label · "drag cards to
  rearrange" hint · Customize · ×).
- Cards are 300×190 `card-bg-soft` tiles in a horizontally scrolling row;
  vertical stack on tablet.
- **Drag & drop reorder** (desktop only): cards are HTML5-draggable; the
  order persists as `workspace.dashboardOrder` (unknown ids ignored, new
  cards append in registry order). The Activity card is fixed first and not
  draggable. Tablet relies on registry order — touch DnD is deliberately
  out of scope.

## Cards

| Card | Description | Status |
|---|---|---|
| **Activity** (fixed) | Project count, per-format chips, "Continue <last project>" jump-back button. Absorbed the old Library-summary widget. | shipped |
| **Recent projects** | Last 5 projects, click to open. | shipped |
| **Pinned notes** | Editable scratchpad, persisted in localStorage. | shipped |
| **Focus timer** | Pomodoro 25/5/15 with start/pause/reset. State survives navigation (module-scope); no chime yet. | shipped |

All registered cards default to enabled — the panel itself is the opt-in
(default off), so first activation shows a full panel rather than an empty
strip. Future cards from the old wishlist (word-count goal, snippets,
calendar, references queue, quick stats) come back only when their backing
features exist.

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
| `dashboardOrder` | User-arranged card id order |
| `widgets` | Per-card enable map (legacy name kept so pre-dashboard toggles carry over) |
