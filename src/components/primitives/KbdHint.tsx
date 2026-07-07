import type { Component } from "solid-js";
import { For, Show } from "solid-js";
import { shortcutTokens } from "~/lib/shortcuts";
import { isTabletViewport } from "~/stores/viewport-store";

/**
 * Platform-aware keyboard hint. Pass a shortcut token like `"Mod+N"` and we
 * render `⌘ N` on Mac, `Ctrl N` on Windows/Linux, and nothing on tablet
 * viewports (no physical keyboard assumed).
 *
 * The chip itself is `flex items-center justify-center` with `line-height: 1`
 * so the glyph (`⌘`, `⌥`, `⇧`) baselines correctly inside the rounded
 * background — fixing the off-center rendering in the old hand-rolled hints.
 */
export const KbdHint: Component<{
  shortcut: string;
  /** "sm" (default) for small inline hints, "md" for prominent buttons. */
  size?: "sm" | "md";
  /** Optional tone override — "default" uses dim bg, "dark" tints off the accent text color (for accent-grad buttons). */
  tone?: "default" | "dark";
}> = (props) => {
  const tokens = () => shortcutTokens(props.shortcut);
  const size = () => props.size ?? "sm";
  const tone = () => props.tone ?? "default";

  return (
    <Show when={!isTabletViewport()}>
      <span class="inline-flex items-center gap-0.5">
        <For each={tokens()}>
          {(token) => (
            <kbd
              class={`mono inline-flex items-center justify-center rounded ${
                size() === "md"
                  ? "h-[18px] min-w-[18px] px-1 text-xs"
                  : "h-[14px] min-w-[14px] px-1 text-[10px]"
              }`}
              style={
                tone() === "dark"
                  ? {
                      background: "color-mix(in srgb, var(--color-accent-fg) 16%, transparent)",
                      color: "var(--color-accent-fg)",
                      "line-height": "1",
                    }
                  : {
                      background: "var(--color-control-fill)",
                      color: "var(--color-fg-2)",
                      border: "1px solid var(--color-control-stroke)",
                      "line-height": "1",
                    }
              }
            >
              {token}
            </kbd>
          )}
        </For>
      </span>
    </Show>
  );
};
