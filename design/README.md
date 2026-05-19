# Typeward — Design System Docs

Living docs for UI/UX decisions. **Update these alongside any visible change.**

## Index

- [`density.md`](./density.md) — Compact / Cozy / Comfortable density tokens
- [`motion.md`](./motion.md) — Animation toggle, transition timings, motion-reduced behavior
- [`themes.md`](./themes.md) — Built-in themes catalog + custom theme paradigm (JSON files)
- [`widgets.md`](./widgets.md) — Projects screen widget shelf catalog + enable/disable
- [`screens-projects.md`](./screens-projects.md) — Projects screen redesign spec
- [`screens-editor.md`](./screens-editor.md) — Editor screen redesign spec
- [`screens-settings.md`](./screens-settings.md) — Settings screen + new options
- [`chrome.md`](./chrome.md) — Top bars, traffic lights removal, icon sizing, route memory

## Conventions

- **Tokens are sources of truth.** Component code references CSS custom properties
  (e.g. `var(--ui-font-base)`), not literal Tailwind utilities like `text-[14px]`,
  whenever a value is density- or theme-dependent.
- **Designs in `design_files/`** are still the visual reference for layout.
  `/design/` describes how we *implement* what those prototypes show.
- **One markdown per concern**, not per file or per ticket. A new pattern earns a
  new doc only when it spans more than one screen.

## Process

1. Before implementing a new pattern, write or update the doc here.
2. Cite token names + filenames so the doc stays grounded.
3. When a pattern is replaced, mark the old section with `> Deprecated YYYY-MM-DD`
   and add a forward pointer.
