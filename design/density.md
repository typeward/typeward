# UI Density

Three density modes, swapped via `<html data-density="...">`. Cozy is default.

## Type scale

All sizes are whole pixels. The scale follows a ~1.14 modular ratio between
adjacent steps. Body sizes stay above the 12px accessibility floor in every
mode.

| Token | Compact | **Cozy** | Comfortable | Used for |
|---|---|---|---|---|
| `--ui-font-xs` | 10 | 11 | 12 | mono captions, `.label-xs` |
| `--ui-font-sm` | 11 | 12 | 14 | hints, secondary text |
| `--ui-font-base` | **12** | **14** | **16** | **body, menu/list items, buttons** |
| `--ui-font-lg` | 14 | 16 | 18 | card titles, section h2 |
| `--ui-font-xl` | 18 | 22 | 26 | page heading, screen h1 |

Body is **`--ui-font-base`** — every sidebar item, button, and form control
inherits from here by default unless it's deliberately small (hints, captions)
or display-scale (headings).

## Rhythm + spacing

| Token | Compact | Cozy | Comfortable | Used for |
|---|---|---|---|---|
| `--ui-line-tight` | 1.2 | 1.2 | 1.2 | display sizes, headings |
| `--ui-line-snug` | 1.35 | 1.35 | 1.35 | dense UI rows |
| `--ui-line-base` | 1.5 | 1.5 | 1.5 | body |
| `--ui-track-tight` | -0.012em | -0.012em | -0.012em | large/display |
| `--ui-track-loose` | 0.04em | 0.04em | 0.04em | uppercase labels |

Line-height + letter-spacing don't scale with density — they're typographic
constants that produce different visual results just because the font size
changes underneath.

## Row heights + padding

| Token | Compact | Cozy | Comfortable |
|---|---|---|---|
| `--ui-row` | 28px | 32px | 40px |
| `--ui-row-sm` | 24px | 28px | 36px |
| `--ui-row-lg` | 36px | 40px | 48px |
| `--ui-pad-card` | 12px | 16px | 20px |
| `--ui-pad-section` | 8px | 12px | 16px |
| `--ui-pad-inline` | 8px | 10px | 14px |
| `--ui-gap-section` | 8px | 12px | 16px |
| `--ui-gap-inline` | 6px | 8px | 12px |

Comfortable's `--ui-row` at 40px meets the 44px touch-target recommendation
once tap-padding is included; the lift-up animation on hover crosses that
threshold. Compact never drops below 24px for an interactive row.

## Icon sizes

| Token | Compact | Cozy | Comfortable | Used for |
|---|---|---|---|---|
| `--ui-icon-chrome` | 18px | 20px | 24px | top-bar icons (bell, settings, layout) |
| `--ui-icon-menu` | 12px | 14px | 16px | inline icons next to menu/list items |
| `--ui-icon-sm` | 10px | 12px | 14px | tight inline icons (close, more, chevron) |

The menu icon matches the body font size 1:1 — the cap-height of Inter and the
visual weight of lucide stroke icons line up well at that ratio.

## Consumption

Since 2026-07-01, Tailwind's named text sizes ARE the density tokens —
`tokens.css` `@theme` aliases `--text-xs/sm/base/lg/xl` to
`var(--ui-font-*)` (with line-height companions: 1.5 for xs–lg via
`--ui-line-base`, 1.2 for xl via `--ui-line-tight`). Use the named
utilities; the verbose `text-[length:var(--ui-font-xs)]`-style spelling
(one per size) is retired, as are hardcoded `text-[12px]`-style sizes on
the scale:

```tsx
// Body / list items
class="text-base"

// Hints
class="text-xs"

// Inline icon
<FolderIcon class="ui-icon-menu" />

// Density-aware row height
style={{ height: "var(--ui-row)" }}
```

`text-[10px]` stays literal by convention — the micro-caption floor below
the scale (mono badges, kbd chips). Display sizes (18px+ onboarding
headings) also stay literal.

Three utility classes live in `utilities.css`:

```css
.ui-icon-chrome { width: var(--ui-icon-chrome); height: var(--ui-icon-chrome); }
.ui-icon-menu   { width: var(--ui-icon-menu);   height: var(--ui-icon-menu); }
.ui-icon-sm     { width: var(--ui-icon-sm);     height: var(--ui-icon-sm); }
```

For lucide-solid icons, set `class="ui-icon-..."` and omit the `size` prop —
CSS width/height overrides the SVG attrs. The body of `tokens.css` already
sets `font-size: var(--ui-font-base)` and `line-height: var(--ui-line-base)`
globally; components only override when they need a different size.

## Best-practice rules (applied to this design system)

- **No fractional pixels.** Every token rounds to a whole pixel. Half-pixels
  blur on non-Retina displays and don't snap to subpixel-rendered glyph
  widths consistently.
- **≤5 distinct sizes** per density. More than that and the visual hierarchy
  becomes noise.
- **Body ≥ 12px** in every density. Below that, sustained reading suffers and
  fails WCAG sufficiency.
- **Icon ≈ font-size** for inline icons; chrome icons ~1.4× body.
- **Tabular numerals** (`.tnum` utility) for numbers in tables, status bars,
  any vertically-aligned digits.
- **Sentence-case** for menu items, buttons, and section headers. `.label-xs`
  is the one exception (UPPERCASE) because it's deliberately demarcating a
  category, not labeling an action.

## Default per platform

| Platform | Default density |
|---|---|
| Desktop | Cozy |
| Tablet (`isTabletViewport()`) | Comfortable |
| User-set | Persists across viewport changes |

If the user never opens the density picker, mobile auto-selects Comfortable
on first tablet mount. Once they set a value explicitly, it sticks.

## Migration

A sweep on 2026-05-15 rounded every `text-[Xpx]` fractional value to its
nearest integer (9.5 → 10, 10.5 → 11, …, 13.5 → 14) so no surface renders
sub-pixel. The 2026-07-01 design pass migrated the whole live UI (~350
sites) onto the named `text-*` aliases, so every size now rescales with
density; 13px one-offs were absorbed into `text-base`.

Radius tokens (`--ui-radius-sm/base/lg`) were removed 2026-07-01 — they
were never consumed; radii are Tailwind literals (`rounded-md/lg/xl`) and
deliberately do not scale with density.
