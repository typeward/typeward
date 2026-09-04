import {
  SPACE_TINTS,
  coerceSpaceTint,
  type SpaceTint,
} from "~/stores/workspace-store";

/**
 * Named tint palette → CSS color. Ids (not raw colors) live on disk so themes
 * re-tint; this is the single render-layer mapping. Where a theme token exists
 * we reference it so the swatch tracks the active theme; the rest are fixed
 * hues chosen to stay distinguishable across all four themes.
 */
const TINT_COLOR: Record<SpaceTint, string> = {
  accent: "var(--color-accent-1)",
  violet: "#a78bfa",
  teal: "var(--color-accent-2)",
  amber: "var(--color-warn)",
  rose: "var(--color-err)",
  green: "var(--color-ok)",
  slate: "var(--color-fg-3)",
};

/** Resolve a persisted tint id (coerced) to its CSS color. */
export function tintColor(raw: string | undefined): string {
  return TINT_COLOR[coerceSpaceTint(raw)];
}

function hashString(s: string): number {
  let h = 0;
  for (let i = 0; i < s.length; i++) {
    h = (Math.imul(h, 31) + s.charCodeAt(i)) | 0;
  }
  return Math.abs(h);
}

/** Stable per-tag color: hash the tag string into the tint palette. */
export function tagTint(tag: string): string {
  return TINT_COLOR[SPACE_TINTS[hashString(tag) % SPACE_TINTS.length]];
}
