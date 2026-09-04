import { Loader2 } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
// "compact" (h-8) sits between sm and md — named non-ordinally so nobody picks
// it expecting the smallest button (it exists for dense toolbars/dialog footers).
export type ButtonSize = "compact" | "sm" | "md" | "lg";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: JSX.Element;
  trailingIcon?: JSX.Element;
  /** Busy state: spinner in the leading slot, disabled, label kept visible. */
  loading?: boolean;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "accent-grad shadow-[var(--shadow-accent-btn)] enabled:hover:brightness-110 enabled:active:brightness-95",
  secondary:
    "glass-soft text-fg-1 enabled:hover:bg-[var(--color-control-fill-hover)] enabled:active:brightness-95",
  ghost:
    "text-fg-2 enabled:hover:bg-[var(--color-control-fill)] enabled:hover:text-fg-1 enabled:active:brightness-95",
  danger:
    "bg-[var(--color-danger-fill)] text-white enabled:hover:brightness-110 enabled:active:brightness-95",
};

const SIZE: Record<ButtonSize, string> = {
  compact: "h-8 px-2.5 text-sm gap-1.5 rounded-md",
  sm: "h-7 px-2.5 text-sm gap-1.5 rounded-md",
  md: "h-9 px-3 text-base gap-2 rounded-md",
  lg: "h-10 px-4 text-base gap-2 rounded-lg",
};

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "leadingIcon",
    "trailingIcon",
    "loading",
    "disabled",
    "class",
    "children",
  ]);
  return (
    <button
      type="button"
      {...rest}
      disabled={local.disabled || local.loading}
      aria-busy={local.loading ? true : undefined}
      class={[
        "lift inline-flex items-center justify-center font-medium transition disabled:opacity-[var(--ui-disabled-opacity)] disabled:cursor-not-allowed",
        VARIANT[local.variant ?? "secondary"],
        SIZE[local.size ?? "md"],
        local.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {local.loading ? <Loader2 class="ui-icon-sm animate-spin" /> : local.leadingIcon}
      {local.children}
      {local.trailingIcon}
    </button>
  );
};
