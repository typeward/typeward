import { describeIpcError } from "~/lib/errors";
import { FileDown, FileType2, Loader2, MessageSquare, Package } from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import { SoonBadge } from "~/components/primitives/SoonBadge";
import * as ipc from "~/ipc";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { recordError } from "~/lib/telemetry";
import { project } from "~/stores/editor-store";

/**
 * Export dropdown — replaces the old Download icon. "Export PDF" and
 * "Source bundle (.zip)" are real; the pandoc-backed options stay
 * visible-but-disabled until their pipelines exist.
 */

interface ExportOption {
  id: string;
  label: string;
  hint: string;
  icon: () => JSX.Element;
}

const STUB_OPTIONS: ExportOption[] = [
  { id: "pdf-ann", label: "PDF + annotations", hint: "Flatten comments into PDF", icon: () => <FileDown size={13} /> },
  { id: "docx", label: "Word (.docx)", hint: "Pandoc → Word", icon: () => <FileType2 size={13} /> },
  { id: "html", label: "HTML", hint: "Pandoc → standalone HTML", icon: () => <MessageSquare size={13} /> },
];

export const ExportMenu: Component<{
  pdfPath: string | null;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));
  useListboxOpenFocus(open, () => rootRef);
  const onTrigger = () => {
    setError(null);
    setOpen((v) => !v);
  };

  // Shared save-dialog + byte-copy tail for both real exports. The dialog
  // plugin extends the fs scope with the picked path, so the write is
  // allowed even outside $DOCUMENT.
  const copyToChosenDest = async (
    source: string,
    suggested: string,
    filter: { name: string; extensions: string[] },
  ): Promise<void> => {
    const { save } = await import("@tauri-apps/plugin-dialog");
    const { readFile, writeFile } = await import("@tauri-apps/plugin-fs");
    const dest = await save({ defaultPath: suggested, filters: [filter] });
    if (!dest) return; // user cancelled
    const bytes = await readFile(source);
    await writeFile(dest, bytes);
    setOpen(false);
  };

  const exportPdf = async () => {
    const source = props.pdfPath;
    if (!source || busy()) return;
    setError(null);
    setBusy(true);
    try {
      const suggested = source.split(/[\\/]/).pop() ?? "document.pdf";
      await copyToChosenDest(source, suggested, { name: "PDF", extensions: ["pdf"] });
    } catch (e) {
      setError(describeIpcError(e));
      recordError("export-pdf", "PDF export failed", e);
    } finally {
      setBusy(false);
    }
  };

  const exportZip = async () => {
    const p = project();
    if (!p || busy()) return;
    setError(null);
    setBusy(true);
    try {
      const bundle = await ipc.exportProjectZip(p);
      await copyToChosenDest(bundle, `${p.name}-source.zip`, {
        name: "Zip archive",
        extensions: ["zip"],
      });
    } catch (e) {
      setError(describeIpcError(e));
      recordError("export-zip", "source bundle export failed", e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        onClick={onTrigger}
        aria-haspopup="listbox"
        aria-expanded={open()}
        class="lift glass-soft flex h-9 w-9 items-center justify-center rounded-md text-fg-2 hover:bg-[var(--color-control-fill-hover)]"
        title="Export"
        aria-label="Export"
      >
        <FileDown size={16} class="opacity-80" />
      </button>
      <Show when={open()}>
        <div
          role="listbox"
          tabindex={-1}
          onKeyDown={(e) => handleListboxKeydown(e, rootRef, () => setOpen(false))}
          class="glass absolute left-0 top-full z-50 mt-1 w-[260px] rounded-xl"
          style={{ padding: "var(--ui-pad-section)", background: "var(--color-popover-bg)" }}
        >
          <span class="label-xs mb-1 block px-1 text-fg-3">Export as</span>
          <button
            type="button"
            role="option"
            tabindex={-1}
            disabled={!props.pdfPath || busy()}
            onClick={() => void exportPdf()}
            class="flex w-full items-center gap-2.5 rounded-md p-2 text-left enabled:hover:bg-[var(--color-control-fill)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span
              class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
              style={{ background: "var(--color-control-fill)" }}
            >
              <Show when={busy()} fallback={<FileDown size={13} />}>
                <Loader2 size={13} class="animate-spin" />
              </Show>
            </span>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-fg-1">
                Export PDF
              </div>
              <div class="mono mt-0.5 text-[10px] text-fg-3">
                {props.pdfPath ? "Save the compiled PDF as…" : "Compile first"}
              </div>
            </div>
          </button>
          <button
            type="button"
            role="option"
            tabindex={-1}
            disabled={!project() || busy()}
            onClick={() => void exportZip()}
            class="flex w-full items-center gap-2.5 rounded-md p-2 text-left enabled:hover:bg-[var(--color-control-fill)] disabled:cursor-not-allowed disabled:opacity-60"
          >
            <span
              class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
              style={{ background: "var(--color-control-fill)" }}
            >
              <Show when={busy()} fallback={<Package size={13} />}>
                <Loader2 size={13} class="animate-spin" />
              </Show>
            </span>
            <div class="min-w-0 flex-1">
              <div class="text-sm font-medium text-fg-1">
                Source bundle (.zip)
              </div>
              <div class="mono mt-0.5 text-[10px] text-fg-3">
                Sources only — build junk, .git and .typeward excluded
              </div>
            </div>
          </button>
          <For each={STUB_OPTIONS}>
            {(o) => (
              <button
                type="button"
                disabled
                class="flex w-full cursor-not-allowed items-center gap-2.5 rounded-md p-2 text-left opacity-60"
              >
                <span
                  class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  {o.icon()}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-sm font-medium text-fg-1">
                    {o.label}
                  </div>
                  <div class="mono mt-0.5 text-[10px] text-fg-3">{o.hint}</div>
                </div>
                <SoonBadge />
              </button>
            )}
          </For>
          <Show when={error()}>
            <div class="select-text px-2 pt-1 text-xs" style={{ color: "var(--color-err)" }}>
              {error()}
            </div>
          </Show>
        </div>
      </Show>
    </div>
  );
};
