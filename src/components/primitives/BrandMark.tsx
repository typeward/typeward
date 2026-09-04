import type { Component } from "solid-js";
import { isDarkTheme, theme } from "~/themes/theme-store";

/**
 * Ink and amber per surface polarity, lifted from the kit's `mark/` files.
 * Light is not a colour inversion: the amber is deepened there because the dark
 * build's tone sits at 1.7:1 on a light ground, and the right arm would all but
 * vanish.
 */
const PALETTE = {
  dark: { ink: "#FFFBEC", amber: "#F5AD44" },
  light: { ink: "#333536", amber: "#C86D0D" },
} as const;

// Cropped tight to the letterform, as the kit's mark files are, so the mark can
// be spaced against text like type rather than like a padded tile.
const VIEW_BOX = "134.5 124.0 243.0 263.0";
const ASPECT = 243 / 263;

const ARM_LEFT =
  "M138 124L245 124Q248.5 124 246.37 126.78L220.63 160.43Q217.9 164 213.4 164L170.9 164C163.72 164.55 152.32 174.85 145.8 183.1Q144 185.5 141 185.5L137.5 185.5Q134.5 185.5 134.5 182.5L134.5 127.5Q134.5 124 138 124Z";
const STEM =
  "M258.99 141.21L279.61 168.8Q282 172 282 176L282 349C282 364.87 288.97 375.51 302.5 376.86Q305.5 377 305.5 380L305.5 384Q305.5 387 302.5 387L209.5 387Q206.5 387 206.5 384L206.5 380Q206.5 377 209.5 377C222.01 375.61 228.91 366.42 229.88 352.5Q230 349 230 345.5L230 176Q230 172 232.39 168.8L253.01 141.21Q256 137.2 258.99 141.21Z";
const ARM_RIGHT =
  "M374 124L267 124Q263.5 124 265.63 126.78L291.37 160.43Q294.1 164 298.6 164L341.1 164C348.28 164.55 359.68 174.85 366.2 183.1Q368 185.5 371 185.5L374.5 185.5Q377.5 185.5 377.5 182.5L377.5 127.5Q377.5 124 374 124Z";

/**
 * The brand mark, inline — the letterform on its own, no tile behind it
 * (`design_files/icon-kit/mark/mark-on-{dark,light}.svg`). Every surface that
 * shows it in-app already has a background of its own; the tiled builds are for
 * places that have none, which means OS icon slots and the favicon.
 *
 * Inline rather than an `<img>` so it re-tints with the app theme instead of
 * following the OS appearance, and stays crisp at any DPI.
 *
 * `size` is the mark's height; the width follows the letterform's proportions.
 * At 16px and below the letter is weighted up until its two diagonal channels
 * close — left open at that size they fall below a pixel and read as dirt
 * rather than detail. That is the same correction the kit bakes into its
 * `icon-tiny` build, applied here at the size the bare mark needs it.
 */
export const BrandMark: Component<{
  /** Rendered height in CSS pixels; width follows from the letterform. */
  size: number;
  class?: string;
}> = (props) => {
  const p = () => (isDarkTheme(theme()) ? PALETTE.dark : PALETTE.light);
  const weight = () => (props.size <= 16 ? 9 : 0);

  return (
    <svg
      width={Math.round(props.size * ASPECT)}
      height={props.size}
      viewBox={VIEW_BOX}
      class={props.class}
      aria-hidden="true"
    >
      <path
        d={ARM_LEFT}
        fill={p().ink}
        stroke={p().ink}
        stroke-width={weight()}
        stroke-linejoin="round"
      />
      <path
        d={STEM}
        fill={p().ink}
        stroke={p().ink}
        stroke-width={weight()}
        stroke-linejoin="round"
      />
      <path
        d={ARM_RIGHT}
        fill={p().amber}
        stroke={p().amber}
        stroke-width={weight()}
        stroke-linejoin="round"
      />
    </svg>
  );
};

export default BrandMark;
