# Widgets shelf — Projects screen

The center column on the Projects screen has an optional "widget shelf" between
the top toolbar (Widgets dropdown + search + sort + view toggle) and the project
grid. The shelf is **hidden by default** — only shows when ≥1 widget is enabled.

> **Note (2026-05-15):** Compose + Recent activity were originally widgets but
> got promoted back to the full-width `ComposerHero` panel above the toolbar
> (the original layout). The widget shelf is now strictly for *additional*
> optional surfaces — all widgets in the catalog start disabled.

## Activation

1. Click the **Widgets** button (replaces the old "Import" button in toolbar).
2. Dropdown lists every widget with a toggle. State persists per-user.
3. As soon as one widget is enabled, the shelf appears below the toolbar.
4. Disable all of them and the shelf collapses again.

## First-round catalog

Each widget is a self-contained card (`glass-soft` background, density-aware
padding). The shelf is a horizontally scrolling row when widgets overflow.

| Widget | Description | Status |
|---|---|---|
| ~~**Compose**~~ | ~~Prompt → new project~~ | **promoted to ComposerHero** (lives above toolbar, not a widget) |
| ~~**Recent activity**~~ | ~~Timeline of recent edits~~ | **promoted to ComposerHero**'s right-side activity card |
| **Pinned notes** | A small editable scratchpad. One per user, persists. Markdown rendered. | new |
| **Focus timer** | Pomodoro: 25/5/15 default, customizable. Counts down + chimes. | new |
| **Word count goal** | Daily/weekly target across all projects. Progress ring. | new |
| **Snippets library** | Frequently-used LaTeX/Typst/Markdown snippets, click-to-copy. | new |
| **Calendar / deadlines** | Project deadlines + system calendar peek. | new (stub) |
| **AI suggest** | One-line "What would you like to write today?" → suggests project from prompt. | new (stub, needs AI work) |
| **Quick stats** | Compile count this week, words this week, time spent. | new |
| **References queue** | A scratch list of papers / URLs to read later. | new |

## Status legend

- **port** = code exists, factor out into widget shape
- **new** = build from scratch, no AI deps
- **new (stub)** = build the shell, return placeholder content until backing
  feature lands

## Widget contract

Each widget exports:

```ts
interface Widget {
  id: string;                   // stable, used in settings persistence
  title: string;
  defaultEnabled: boolean;
  icon: () => JSX.Element;
  Render: Component<{ density: Density }>;
  /** Used to sort widgets in the shelf. Lower = leftmost. */
  order: number;
}
```

Widgets register through `src/widgets/registry.ts`. The shelf reads the
registry + the user's enable map and renders accordingly.

## v0 shipping set

Compose + Recent activity now live in the full-width ComposerHero, not the
widget shelf. Of the optional widgets, only **Pinned notes** is functional;
the rest are registered as "Coming soon" stubs so users can see the catalog.
All start disabled — users opt in via the Widgets dropdown.

## Layout

- Single horizontal row when ≤3 widgets enabled.
- Horizontal scroll on overflow (mouse wheel + scrollbar; touch swipe on tablet).
- Each widget min-width 280px, max-width 420px. Heights match the tallest
  widget in the row (CSS grid `grid-template-rows: 1fr`).

## Tablet adaptations

- Shelf collapses to a vertical stack (above the project grid).
- Widget heights become independent, each min-height 180px.
