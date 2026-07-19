import { Switch as KSwitch } from "@kobalte/core/switch";
import type { Component, JSX } from "solid-js";

interface SwitchProps {
  checked: boolean;
  onChange: (checked: boolean) => void;
  label?: string;
  description?: string;
  disabled?: boolean;
  id?: string;
}

/**
 * The visual track + thumb, reusable inside any Kobalte switch root. Reads
 * checked/disabled state from Kobalte's data attributes via context. Must sit
 * after the `peer`-classed KSwitch.Input as a sibling: Kobalte 0.13 emits no
 * data-focus-visible on Switch parts, so the keyboard focus ring rides the
 * hidden input's :focus-visible through Tailwind's peer variant.
 */
export const SwitchControl: Component = () => (
  <KSwitch.Control class="relative inline-flex h-[18px] w-[32px] shrink-0 items-center rounded-full border border-glass-stroke-strong bg-control-track-off transition data-[checked]:border-transparent data-[checked]:accent-grad data-[disabled]:opacity-[var(--ui-disabled-opacity)] peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[var(--color-focus-ring)]">
    {/* Thumb is constant per theme; the track carries state (platform
        convention). The hairline keeps a light thumb defined on light
        accents once --shadow-raised is zeroed on the basic themes. */}
    <KSwitch.Thumb class="block h-[14px] w-[14px] translate-x-[2px] rounded-full border border-[var(--color-control-thumb-stroke)] bg-[var(--color-control-thumb)] shadow-[var(--shadow-raised)] transition-transform data-[checked]:translate-x-[16px]" />
  </KSwitch.Control>
);

/**
 * Themed Switch built on Kobalte's accessible primitive. Track + thumb colors
 * tie to the active accent palette, so they update with `data-accent`.
 */
export const Switch: Component<SwitchProps> = (props) => {
  return (
    <KSwitch
      checked={props.checked}
      onChange={props.onChange}
      disabled={props.disabled}
      class="flex items-center gap-3"
    >
      <KSwitch.Input class="peer sr-only" />
      <div class="flex flex-1 flex-col">
        {props.label ? (
          <KSwitch.Label class="text-sm font-medium text-fg-1">
            {props.label}
          </KSwitch.Label>
        ) : null}
        {props.description ? (
          <span class="text-xs text-fg-3">{props.description}</span>
        ) : null}
      </div>
      <SwitchControl />
    </KSwitch>
  );
};

export type { JSX };
