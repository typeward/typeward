# Motion / Animations

Single global toggle: `settings.ui.animations` (boolean, default `true`).

Applied to `<html data-motion="full" | "reduced">`. When `reduced`:

- **Transitions** are reduced to `0.01ms` (functional 0 — keeps `transitionend`
  events firing, avoids race conditions in code that relies on them).
- **Animations** are reduced to `0.01ms`.
- The OS-level `prefers-reduced-motion` media query still wins — if the user has
  it set at the OS level, we force `reduced` regardless of the in-app toggle.

## CSS

```css
:root[data-motion="reduced"] *,
:root[data-motion="reduced"] *::before,
:root[data-motion="reduced"] *::after,
@media (prefers-reduced-motion: reduce) {
  *, *::before, *::after {
    transition-duration: 0.01ms !important;
    animation-duration: 0.01ms !important;
    animation-iteration-count: 1 !important;
    scroll-behavior: auto !important;
  }
}
```

## Animations catalog

Effects already in place (`src/themes/utilities.css`):

| Name | Used for | Honors motion toggle? |
|---|---|---|
| `pulse-dot` | Save/compile status indicators | Yes (auto via animation-duration override) |
| `blink` | Composer caret | Yes |
| `shimmer` | Loading skeleton | Yes |
| `synctex-pulse` | PDF forward-search highlight | Yes |
| `border-flow` | Composer top edge animated gradient | Yes |

New patterns added in this overhaul:

| Name | Used for | Notes |
|---|---|---|
| `panel-slide-in` / `out` | Right-side notifications panel show/hide | 240ms cubic-bezier(0.2, 0.8, 0.2, 1) |
| `card-hover-glow` | Project card hover border + glow | Hover-only; CSS-only, no JS |
| `dropdown-fade` | Sort / layout / export menus | 150ms ease-out |

## Hover effects

Stay on at all density levels and motion settings — they're CSS-only and don't
animate per se. Pure brightness/border swaps remain even when motion is reduced;
keyframes don't.

## Reduced-motion edge cases

- **Pagination / scroll-to-page** in PDF stays smooth — that's a behavior, not
  decoration. We use `scroll-behavior: smooth` normally; the `auto !important`
  override above handles the reduced case.
- **PaneSwitcher cycle on swipe** is instant. Pane content swap doesn't
  animate today, doesn't need to.
