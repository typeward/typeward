import type { Component, JSX } from "solid-js";
import { splitProps } from "solid-js";

export type ButtonVariant = "primary" | "secondary" | "ghost" | "danger";
export type ButtonSize = "sm" | "md" | "lg";

interface ButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: ButtonVariant;
  size?: ButtonSize;
  leadingIcon?: JSX.Element;
  trailingIcon?: JSX.Element;
}

const VARIANT: Record<ButtonVariant, string> = {
  primary:
    "accent-grad text-white shadow-[inset_0_1px_0_rgba(255,255,255,0.25),0_4px_14px_rgba(0,0,0,0.35)] hover:brightness-110",
  secondary:
    "glass-soft text-fg-1 hover:bg-[var(--color-control-fill-hover)]",
  ghost: "text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1",
  danger:
    "bg-[var(--color-err)] text-white hover:brightness-110",
};

const SIZE: Record<ButtonSize, string> = {
  sm: "h-7 px-2.5 text-[12px] gap-1.5 rounded-md",
  md: "h-9 px-3 text-[13px] gap-2 rounded-md",
  lg: "h-10 px-4 text-[13px] gap-2 rounded-lg",
};

export const Button: Component<ButtonProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "variant",
    "size",
    "leadingIcon",
    "trailingIcon",
    "class",
    "children",
  ]);
  return (
    <button
      type="button"
      {...rest}
      class={[
        "lift inline-flex items-center justify-center font-medium transition disabled:opacity-50 disabled:cursor-not-allowed",
        VARIANT[local.variant ?? "secondary"],
        SIZE[local.size ?? "md"],
        local.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
    >
      {local.leadingIcon}
      {local.children}
      {local.trailingIcon}
    </button>
  );
};
