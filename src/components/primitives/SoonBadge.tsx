import type { Component } from "solid-js";

/** House pattern for visible-but-unbuilt controls. */
export const SoonBadge: Component = () => (
  <span
    class="mono rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
    style={{ background: "var(--color-control-fill)", color: "var(--color-fg-3)" }}
  >
    soon
  </span>
);
