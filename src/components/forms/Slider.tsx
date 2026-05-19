import { Slider as KSlider } from "@kobalte/core/slider";
import type { Component } from "solid-js";

interface SliderProps {
  value: number;
  onChange: (value: number) => void;
  min?: number;
  max?: number;
  step?: number;
  label?: string;
  unit?: string;
}

export const Slider: Component<SliderProps> = (props) => {
  return (
    <KSlider
      value={[props.value]}
      onChange={(values) => props.onChange(values[0])}
      minValue={props.min ?? 0}
      maxValue={props.max ?? 100}
      step={props.step ?? 1}
      class="flex flex-col gap-1.5"
    >
      <div class="flex items-center justify-between">
        {props.label ? (
          <KSlider.Label class="text-[12px] font-medium text-fg-1">
            {props.label}
          </KSlider.Label>
        ) : (
          <span />
        )}
        <KSlider.ValueLabel class="text-[11px] text-fg-2 mono">
          {props.value}
          {props.unit ?? ""}
        </KSlider.ValueLabel>
      </div>
      <KSlider.Track class="relative h-[6px] rounded-full bg-glass-fill">
        <KSlider.Fill class="absolute inset-y-0 left-0 rounded-full accent-grad" />
        <KSlider.Thumb class="block h-[14px] w-[14px] -mt-1 rounded-full bg-fg-1 shadow-[0_2px_6px_rgba(0,0,0,0.5)] outline-none data-[focus-visible]:ring-2 data-[focus-visible]:ring-accent-1">
          <KSlider.Input />
        </KSlider.Thumb>
      </KSlider.Track>
    </KSlider>
  );
};
