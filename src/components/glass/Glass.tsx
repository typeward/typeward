import type { Component, JSX } from "solid-js";

export type GlassVariant = "default" | "soft" | "inset";

interface GlassProps extends JSX.HTMLAttributes<HTMLDivElement> {
  variant?: GlassVariant;
  /** Add a subtle hover lift transition (use for clickable cards). */
  lift?: boolean;
}

const VARIANT_CLASS: Record<GlassVariant, string> = {
  default: "glass",
  soft: "glass-soft",
  inset: "glass-inset",
};

/**
 * Theme-aware surface ported from `design_files/Editor.html`. All variants
 * read their colors and shadows from CSS custom properties so theme + accent
 * switches re-skin instantly.
 */
export const Glass: Component<GlassProps> = (props) => {
  const variant = (): GlassVariant => props.variant ?? "default";
  return (
    <div
      {...props}
      class={[
        VARIANT_CLASS[variant()],
        props.lift ? "lift" : "",
        "rounded-xl",
        props.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    />
  );
};
