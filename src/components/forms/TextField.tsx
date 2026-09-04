import type { Component, JSX } from "solid-js";
import { Show, createUniqueId, splitProps } from "solid-js";

export type TextFieldSize = "sm" | "md" | "lg";

interface TextFieldProps
  extends Omit<JSX.InputHTMLAttributes<HTMLInputElement>, "size"> {
  label?: string;
  /** Render the label sr-only (dense rows that already have visible context). */
  hideLabel?: boolean;
  description?: string;
  error?: string;
  size?: TextFieldSize;
  mono?: boolean;
}

const SIZE: Record<TextFieldSize, string> = {
  sm: "h-8 px-2.5 text-sm",
  md: "h-9 px-2.5 text-sm",
  // Dialog-primary inputs (template name, DOI lookup) keep their roomier
  // pre-migration metrics.
  lg: "h-10 px-3 text-base",
};

/**
 * The house text input: real <label> wrapping a styled span + input, on the
 * glass-inset recipe. The focus treatment is a 2px outline in
 * --color-focus-ring — the old 1px accent ring was sub-perceptible on glass
 * surfaces.
 */
export const TextField: Component<TextFieldProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "label",
    "hideLabel",
    "description",
    "error",
    "size",
    "mono",
    "class",
    "aria-describedby",
  ]);
  const uid = createUniqueId();
  const descriptionId = () =>
    local.description ? `textfield-${uid}-description` : undefined;
  const errorId = () => (local.error ? `textfield-${uid}-error` : undefined);
  const describedBy = () => {
    const ids = [local["aria-describedby"], descriptionId(), errorId()].filter(
      Boolean,
    );
    return ids.length > 0 ? ids.join(" ") : undefined;
  };
  return (
    <label class="flex flex-col gap-1">
      <Show when={local.label}>
        <span
          class={
            local.hideLabel ? "sr-only" : "text-sm font-medium text-fg-2"
          }
        >
          {local.label}
        </span>
      </Show>
      <input
        {...rest}
        class={[
          "glass-inset rounded-md text-fg-1 placeholder:text-fg-2 outline-none focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--color-focus-ring)]",
          SIZE[local.size ?? "md"],
          local.mono ? "mono" : "",
          local.class ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
        aria-invalid={local.error ? true : undefined}
        aria-describedby={describedBy()}
      />
      <Show when={local.description}>
        <span id={descriptionId()} class="text-xs text-fg-3">
          {local.description}
        </span>
      </Show>
      <Show when={local.error}>
        <span id={errorId()} class="text-xs text-[var(--color-err)]">
          {local.error}
        </span>
      </Show>
    </label>
  );
};
