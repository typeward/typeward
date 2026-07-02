import { Columns3, FileText, FileType2, Layout as LayoutIcon, Terminal } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Show, createSignal } from "solid-js";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import {
  type ConsolePosition,
  type EditorLayout,
  consolePosition,
  editorLayout,
  setConsolePosition,
  setEditorLayout,
} from "~/stores/ui-store";

/**
 * Two-section popover: pane layout + console position. State persists via
 * `ui-store` (workspace settings will pick this up when Phase E lands).
 */
export const LayoutMenu: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  useListboxOpenFocus(open, () => rootRef);
  const onTrigger = () => setOpen((v) => !v);

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        title="Layout"
        aria-label="Layout"
        onClick={onTrigger}
        aria-haspopup="listbox"
        aria-expanded={open()}
        class="lift flex h-9 w-9 items-center justify-center rounded-md hover:bg-[var(--color-control-fill)]"
      >
        <LayoutIcon class="ui-icon-chrome" style={{ opacity: 0.85 }} />
      </button>
      <Show when={open()}>
        <div
          tabindex={-1}
          onKeyDown={(e) => handleListboxKeydown(e, rootRef, () => setOpen(false))}
          class="glass absolute right-0 top-full z-50 mt-1 w-[260px] rounded-xl"
          style={{
            padding: "var(--ui-pad-section)",
            background: "var(--color-popover-bg)",
          }}
        >
          {/* Each single-select group is its own listbox — one listbox with
              two always-selected options would announce as multi-select. */}
          <Section label="Pane layout">
            <LayoutOption
              value="split"
              current={editorLayout()}
              onChoose={setEditorLayout}
              icon={<Columns3 size={13} />}
              label="Split view"
              hint="Files + Editor + Preview"
            />
            <LayoutOption
              value="editor"
              current={editorLayout()}
              onChoose={setEditorLayout}
              icon={<FileType2 size={13} />}
              label="Editor only"
              hint="Hide preview"
            />
            <LayoutOption
              value="preview"
              current={editorLayout()}
              onChoose={setEditorLayout}
              icon={<FileText size={13} />}
              label="PDF only"
              hint="Hide editor"
            />
          </Section>
          <div class="my-2 h-px" style={{ background: "var(--color-control-stroke)" }} />
          <Section label="Logs">
            <ConsoleOption
              value="pdf-tab"
              current={consolePosition()}
              onChoose={setConsolePosition}
              label="In preview panel"
              hint="Logs become a tab next to the PDF"
            />
            <ConsoleOption
              value="drawer"
              current={consolePosition()}
              onChoose={setConsolePosition}
              label="Bottom drawer"
              hint="Logs strip below the editor"
            />
          </Section>
        </div>
      </Show>
    </div>
  );
};

const Section: Component<{ label: string; children: JSX.Element }> = (props) => (
  <div class="flex flex-col gap-0.5">
    <span class="label-xs mb-1 px-1 text-fg-3">{props.label}</span>
    <div role="listbox" aria-label={props.label} class="flex flex-col gap-0.5">
      {props.children}
    </div>
  </div>
);

const LayoutOption: Component<{
  value: EditorLayout;
  current: EditorLayout;
  onChoose: (v: EditorLayout) => void;
  icon: JSX.Element;
  label: string;
  hint: string;
}> = (props) => {
  const active = () => props.current === props.value;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active()}
      tabindex={-1}
      onClick={() => props.onChoose(props.value)}
      class={`lift flex items-center gap-2.5 rounded-md p-2 text-left ${
        active()
          ? "bg-[var(--color-control-fill-hover)]"
          : "hover:bg-[var(--color-control-fill)]"
      }`}
    >
      <span
        class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
        style={{
          background: active() ? "color-mix(in srgb, var(--color-accent-1) 16%, transparent)" : "var(--color-control-fill)",
          color: active() ? "var(--color-accent-1)" : "var(--color-fg-2)",
        }}
      >
        {props.icon}
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium text-fg-1">
          {props.label}
        </div>
        <div class="mono mt-0.5 text-[10px] text-fg-3">{props.hint}</div>
      </div>
      <Show when={active()}>
        <span class="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-accent-1)" }} />
      </Show>
    </button>
  );
};

const ConsoleOption: Component<{
  value: ConsolePosition;
  current: ConsolePosition;
  onChoose: (v: ConsolePosition) => void;
  label: string;
  hint: string;
}> = (props) => {
  const active = () => props.current === props.value;
  return (
    <button
      type="button"
      role="option"
      aria-selected={active()}
      tabindex={-1}
      onClick={() => props.onChoose(props.value)}
      class={`lift flex items-center gap-2.5 rounded-md p-2 text-left ${
        active()
          ? "bg-[var(--color-control-fill-hover)]"
          : "hover:bg-[var(--color-control-fill)]"
      }`}
    >
      <span
        class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
        style={{
          background: active() ? "color-mix(in srgb, var(--color-accent-1) 16%, transparent)" : "var(--color-control-fill)",
          color: active() ? "var(--color-accent-1)" : "var(--color-fg-2)",
        }}
      >
        <Terminal size={13} />
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium text-fg-1">
          {props.label}
        </div>
        <div class="mono mt-0.5 text-[10px] text-fg-3">{props.hint}</div>
      </div>
      <Show when={active()}>
        <span class="h-1.5 w-1.5 rounded-full" style={{ background: "var(--color-accent-1)" }} />
      </Show>
    </button>
  );
};
