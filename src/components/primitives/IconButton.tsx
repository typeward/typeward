import type { JSX, ParentComponent } from "solid-js";
import { Show, splitProps } from "solid-js";

import { KbdHint } from "~/components/primitives/KbdHint";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "~/components/primitives/Tooltip";
import { touchAffordances } from "~/stores/viewport-store";

export type IconButtonSize = "sm" | "md" | "lg";
export type IconButtonVariant = "ghost" | "control";

interface IconButtonProps extends JSX.ButtonHTMLAttributes<HTMLButtonElement> {
  /** Required accessible name — becomes aria-label AND the tooltip content. */
  label: string;
  size?: IconButtonSize;
  variant?: IconButtonVariant;
  /**
   * Opt-in 44px bump on coarse pointers. Off by default: inside fixed-height
   * chrome (top bars) an unconditional bump overflows the row. Keyed on
   * touchAffordances() — pointer coarseness is the correct signal; narrow
   * desktop windows keep their sizes and landscape tablets get the bump.
   */
  touchTarget?: boolean;
  /**
   * Shortcut token ("Mod+B") rendered as a KbdHint beside the tooltip label.
   * Visual only — kept out of aria-label so screen readers get the clean name.
   */
  shortcut?: string;
}

const SIZE: Record<IconButtonSize, string> = {
  sm: "h-6 w-6",
  md: "h-7 w-7",
  lg: "h-9 w-9",
};

const VARIANT: Record<IconButtonVariant, string> = {
  ghost:
    "text-fg-3 enabled:hover:bg-[var(--color-control-fill)] enabled:hover:text-fg-1",
  control:
    "border border-[var(--color-control-stroke)] bg-[var(--color-control-fill)] text-fg-2 enabled:hover:bg-[var(--color-control-fill-hover)] enabled:hover:text-fg-1",
};

/**
 * Icon-only button with a mandatory accessible name. The Tooltip replaces
 * title= (native titles are unstyled, laggy, and skip keyboard focus).
 * Children = the icon element.
 */
export const IconButton: ParentComponent<IconButtonProps> = (props) => {
  const [local, rest] = splitProps(props, [
    "label",
    "size",
    "variant",
    "class",
    "children",
    "touchTarget",
    "shortcut",
  ]);
  const sizeClass = () =>
    local.touchTarget && touchAffordances()
      ? "h-11 w-11"
      : SIZE[local.size ?? "md"];
  return (
    <Tooltip>
      <TooltipTrigger
        as="button"
        type="button"
        aria-label={local.label}
        {...rest}
        class={[
          "lift inline-flex flex-shrink-0 items-center justify-center rounded-md transition disabled:opacity-[var(--ui-disabled-opacity)] disabled:cursor-not-allowed",
          VARIANT[local.variant ?? "ghost"],
          sizeClass(),
          local.class ?? "",
        ]
          .filter(Boolean)
          .join(" ")}
      >
        {local.children}
      </TooltipTrigger>
      <TooltipContent>
        <span class="inline-flex items-center gap-1.5">
          {local.label}
          <Show when={local.shortcut}>
            {(shortcut) => <KbdHint shortcut={shortcut()} />}
          </Show>
        </span>
      </TooltipContent>
    </Tooltip>
  );
};
