import { CheckCircle2, XCircle } from "lucide-solid";
import type { Component } from "solid-js";
import { Show } from "solid-js";
import type { CellRunResult } from "~/ipc";

/**
 * Output panel rendered below a code cell after a run. Today we show
 * the captured stdout + stderr as preformatted text plus a small status
 * footer (exit code + duration). Plot/image capture is deferred — when
 * we add it, it slots in here as a new section above stdout.
 */
export const CellOutput: Component<{ result: CellRunResult }> = (props) => {
  return (
    <div class="space-y-1.5 px-2 py-2">
      <Show when={props.result.stdout.length > 0}>
        <pre
          class="mono max-h-[300px] overflow-auto scroll rounded-md px-2.5 py-2 text-[12px] leading-relaxed text-fg-1"
          style={{
            background: "var(--color-overlay-deep)",
            border: "1px solid var(--color-control-stroke)",
            "white-space": "pre-wrap",
          }}
        >
          {props.result.stdout}
        </pre>
      </Show>
      <Show when={props.result.stderr.length > 0}>
        <pre
          class="mono max-h-[300px] overflow-auto scroll rounded-md px-2.5 py-2 text-[12px] leading-relaxed"
          style={{
            background: "rgba(244,63,94,0.06)",
            border: "1px solid rgba(244,63,94,0.18)",
            color: props.result.ok ? "var(--color-fg-2)" : "var(--color-err)",
            "white-space": "pre-wrap",
          }}
        >
          {props.result.stderr}
        </pre>
      </Show>
      <Show
        when={props.result.stdout.length === 0 && props.result.stderr.length === 0}
      >
        <div class="mono px-2.5 py-1 text-[11px] text-fg-3">
          (no output)
        </div>
      </Show>
      <div class="mono flex items-center gap-2 px-2.5 text-[10px] text-fg-3">
        <Show
          when={props.result.ok}
          fallback={<XCircle size={10} class="text-[var(--color-err)]" />}
        >
          <CheckCircle2 size={10} class="text-[var(--color-ok)]" />
        </Show>
        <span>
          exit {props.result.exitCode} · {props.result.durationMs}ms
        </span>
      </div>
    </div>
  );
};
