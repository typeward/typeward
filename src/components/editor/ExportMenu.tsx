import { FileDown, FileType2, MessageSquare, Package } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal, onCleanup } from "solid-js";

/**
 * Export dropdown — replaces the old Download icon. Each option is a UI stub
 * today; backing pipelines (pandoc → docx/html, annotation flattening, zip
 * bundle) land in a follow-up slice. PDF export becomes a one-liner once
 * `fs:allow-write-file` is added to capabilities for arbitrary destinations.
 */

interface ExportOption {
  id: string;
  label: string;
  hint: string;
  icon: () => JSX.Element;
}

export const ExportMenu: Component<{
  pdfPath: string | null;
}> = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;

  const handleDocClick = (e: MouseEvent) => {
    if (!rootRef) return;
    if (rootRef.contains(e.target as Node)) return;
    setOpen(false);
  };
  const onTrigger = () => {
    setOpen((v) => !v);
    if (!open()) return;
    setTimeout(() => document.addEventListener("click", handleDocClick), 0);
  };
  onCleanup(() => document.removeEventListener("click", handleDocClick));

  const options: ExportOption[] = [
    { id: "pdf", label: "Export PDF", hint: "Copy the compiled PDF", icon: () => <FileDown size={13} /> },
    { id: "pdf-ann", label: "PDF + annotations", hint: "Flatten comments into PDF", icon: () => <FileDown size={13} /> },
    { id: "docx", label: "Word (.docx)", hint: "Pandoc → Word", icon: () => <FileType2 size={13} /> },
    { id: "html", label: "HTML", hint: "Pandoc → standalone HTML", icon: () => <MessageSquare size={13} /> },
    { id: "source", label: "Source bundle (.zip)", hint: "Project folder, gitignored excluded", icon: () => <Package size={13} /> },
  ];

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        onClick={onTrigger}
        class="lift glass-soft flex h-9 w-9 items-center justify-center rounded-md text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
        title="Export"
        aria-label="Export"
      >
        <FileDown size={16} class="opacity-80" />
      </button>
      <Show when={open()}>
        <div
          class="glass absolute left-0 top-full z-50 mt-1 w-[260px] rounded-xl"
          style={{ padding: "var(--ui-pad-section)", background: "var(--color-popover-bg)" }}
        >
          <span class="label-xs mb-1 block px-1 text-fg-3">Export as</span>
          <For each={options}>
            {(o) => (
              <button
                type="button"
                onClick={() => setOpen(false)}
                class="lift flex w-full items-center gap-2.5 rounded-md p-2 text-left opacity-80 hover:bg-[var(--color-control-fill)]"
              >
                <span
                  class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  {o.icon()}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                    {o.label}
                  </div>
                  <div class="mono mt-0.5 text-[10px] text-fg-3">{o.hint}</div>
                </div>
                <span
                  class="mono rounded px-1 text-[9px]"
                  style={{
                    background: "var(--color-control-fill)",
                    color: "var(--color-fg-3)",
                  }}
                >
                  soon
                </span>
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};
