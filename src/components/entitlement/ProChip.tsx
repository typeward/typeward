import { Lock } from "lucide-solid";
import type { Component } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { setRequestProDialog } from "~/commands/palette-store";

/**
 * Quiet locked-feature marker: a small lock + "Pro" pill in the SoonBadge
 * palette. Selected discovery surfaces (Settings nav, format picker,
 * template gallery, sidebar tabs) render it next to a locked feature —
 * amendment (2026-07-08) to the locked-renders-nothing rule. It never
 * pulses, never gates on its own; with `onClick` it becomes a button that
 * opens the ProDialog, otherwise the enclosing surface handles the click.
 */
export const ProChip: Component<{ onClick?: () => void; title?: string }> = (
  props,
) => {
  const body = (
    <>
      <Lock size={9} style={{ opacity: 0.8 }} />
      Pro
    </>
  );
  const cls =
    "mono inline-flex items-center gap-1 rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider";
  const style = {
    background: "var(--color-control-fill)",
    color: "var(--color-fg-3)",
  };
  return props.onClick ? (
    <button
      type="button"
      onClick={props.onClick}
      title={props.title ?? "Part of Typeward Pro"}
      class={`lift ${cls}`}
      style={style}
    >
      {body}
    </button>
  ) : (
    <span class={cls} style={style} title={props.title}>
      {body}
    </span>
  );
};

/**
 * Slim locked-state body for a panel whose feature is Pro-gated: one calm
 * line plus a "See what's in Pro" button that opens the ProDialog. Used by
 * the Settings integration sections and the editor sidebar Refs/SCM tabs.
 */
export const ProLockedPanel: Component<{ class?: string }> = (props) => (
  <div
    class={`flex flex-col items-center justify-center gap-2.5 px-4 py-10 text-center ${props.class ?? ""}`}
  >
    <div class="text-sm text-fg-3">Part of Typeward Pro.</div>
    <Button variant="secondary" size="sm" onClick={() => setRequestProDialog(true)}>
      See what's in Pro
    </Button>
  </div>
);
