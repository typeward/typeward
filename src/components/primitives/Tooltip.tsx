import { Tooltip as KTooltip } from "@kobalte/core/tooltip";
import type { ComponentProps, ParentComponent } from "solid-js";

/**
 * Thin Kobalte tooltip wrapper. The root defaults to a ~600ms open delay and
 * (Kobalte default) opens on both hover and keyboard focus. Content is a
 * small static glass popover — no entrance animation, so nothing to gate on
 * data-motion. Compose as:
 *
 *   <Tooltip>
 *     <TooltipTrigger as="button" ...>...</TooltipTrigger>
 *     <TooltipContent>Label</TooltipContent>
 *   </Tooltip>
 */
export const Tooltip: ParentComponent<ComponentProps<typeof KTooltip>> = (
  props,
) => <KTooltip openDelay={600} {...props} />;

export const TooltipTrigger = KTooltip.Trigger;

export const TooltipContent: ParentComponent<{ class?: string }> = (props) => (
  <KTooltip.Portal>
    {/* z-[60]: tooltips must layer above dialog content (z-50). */}
    <KTooltip.Content
      class={[
        "glass z-[60] max-w-[280px] rounded-lg px-2 py-1 text-xs text-fg-1",
        props.class ?? "",
      ]
        .filter(Boolean)
        .join(" ")}
      style={{ background: "var(--color-popover-bg)" }}
    >
      {props.children}
    </KTooltip.Content>
  </KTooltip.Portal>
);
