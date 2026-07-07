import { describeIpcError } from "~/lib/errors";
import {
  FileCode,
  FileDown,
  FileType2,
  Loader2,
  MessageSquare,
  Package,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Show, createSignal } from "solid-js";
import * as ipc from "~/ipc";
import { installDismiss } from "~/lib/dismiss";
import { handleListboxKeydown, useListboxOpenFocus } from "~/lib/listbox-nav";
import { offsetToLine } from "~/lib/reviews/lines";
import { notifyInfo, notifySuccess } from "~/lib/toast";
import { recordError } from "~/lib/telemetry";
import { openFiles, project } from "~/stores/editor-store";
import { allThreads } from "~/stores/review-store";

/**
 * Export dropdown — replaces the old Download icon. All five options are real:
 * the compiled PDF and source zip copy existing artifacts; Word/HTML shell out
 * to pandoc; "PDF + annotations" flattens open review comments into SyncTeX-
 * placed sticky notes (LaTeX only).
 */

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

  // Shared save-dialog + byte-copy tail for the real exports. The dialog
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

  const exportViaPandoc = async (format: "docx" | "html") => {
    const p = project();
    if (!p || busy()) return;
    setError(null);
    setBusy(true);
    try {
      const artifact = await ipc.exportPandoc(p, format);
      await copyToChosenDest(artifact, `${p.name}.${format}`, {
        name: format === "docx" ? "Word document" : "HTML page",
        extensions: [format],
      });
    } catch (e) {
      setError(describeIpcError(e));
      recordError(`export-${format}`, `${format} export failed`, e);
    } finally {
      setBusy(false);
    }
  };

  const openThreads = () => allThreads().filter((t) => t.status === "open");

  const annEnabled = () =>
    !!props.pdfPath &&
    !busy() &&
    project()?.format === "latex" &&
    openThreads().length > 0;

  const annHint = (): string => {
    const p = project();
    if (p && p.format !== "latex") return "Needs SyncTeX (LaTeX only)";
    if (!props.pdfPath) return "Compile first";
    const n = openThreads().length;
    if (n === 0) return "No open comments to place";
    return `Place ${n} open comment${n === 1 ? "" : "s"} as sticky notes`;
  };

  const exportAnnotated = async () => {
    const p = project();
    if (!p || busy() || !props.pdfPath || p.format !== "latex") return;
    const threads = openThreads();
    if (threads.length === 0) return;
    setError(null);
    setBusy(true);
    try {
      // Read each thread's file once; prefer the live buffer (may hold unsaved
      // edits that shifted offsets) and fall back to disk for unopened files.
      const contentCache = new Map<string, string>();
      const annotations: ipc.AnnotationInput[] = [];
      for (const t of threads) {
        let content = contentCache.get(t.fileRelPath);
        if (content === undefined) {
          const buf = openFiles().find((f) => f.relPath === t.fileRelPath);
          content = buf
            ? buf.content
            : await ipc.readProjectTextFile(p.rootPath, t.fileRelPath);
          contentCache.set(t.fileRelPath, content);
        }
        annotations.push({
          file: t.fileRelPath,
          line: offsetToLine(content, t.fromOffset),
          title: t.comments[0]?.author ?? "Reviewer",
          body: t.comments.map((c) => `${c.author}: ${c.body}`).join("\n"),
        });
      }
      const result = await ipc.exportPdfAnnotated(p, props.pdfPath, annotations);
      await copyToChosenDest(result.path, `${p.name}-annotated.pdf`, {
        name: "PDF",
        extensions: ["pdf"],
      });
      notifySuccess(
        `${result.annotated} comment${result.annotated === 1 ? "" : "s"} placed`,
      );
      if (result.skipped.length > 0) {
        notifyInfo(
          `${result.skipped.length} comment${
            result.skipped.length === 1 ? "" : "s"
          } couldn't be placed`,
          result.skipped
            .slice(0, 5)
            .map((s) => `${s.file}:${s.line} — ${s.reason}`)
            .join("\n"),
        );
      }
    } catch (e) {
      setError(describeIpcError(e));
      recordError("export-annotated", "annotated PDF export failed", e);
    } finally {
      setBusy(false);
    }
  };

  const OptionRow: Component<{
    label: string;
    hint: string;
    icon: JSX.Element;
    disabled: boolean;
    onSelect: () => void;
  }> = (o) => (
    <button
      type="button"
      role="option"
      tabindex={-1}
      disabled={o.disabled}
      onClick={o.onSelect}
      class="flex w-full items-center gap-2.5 rounded-md p-2 text-left enabled:hover:bg-[var(--color-control-fill)] disabled:cursor-not-allowed disabled:opacity-60"
    >
      <span
        class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
        style={{ background: "var(--color-control-fill)" }}
      >
        <Show when={busy()} fallback={o.icon}>
          <Loader2 size={13} class="animate-spin" />
        </Show>
      </span>
      <div class="min-w-0 flex-1">
        <div class="text-sm font-medium text-fg-1">{o.label}</div>
        <div class="mono mt-0.5 text-[10px] text-fg-3">{o.hint}</div>
      </div>
    </button>
  );

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
          <OptionRow
            label="Export PDF"
            hint={props.pdfPath ? "Save the compiled PDF as…" : "Compile first"}
            icon={<FileDown size={13} />}
            disabled={!props.pdfPath || busy()}
            onSelect={() => void exportPdf()}
          />
          <OptionRow
            label="Source bundle (.zip)"
            hint="Sources only — build junk, .git and .typeward excluded"
            icon={<Package size={13} />}
            disabled={!project() || busy()}
            onSelect={() => void exportZip()}
          />
          <OptionRow
            label="PDF + annotations"
            hint={annHint()}
            icon={<MessageSquare size={13} />}
            disabled={!annEnabled()}
            onSelect={() => void exportAnnotated()}
          />
          <OptionRow
            label="Word (.docx)"
            hint="Pandoc → Word — complex macros may not convert"
            icon={<FileType2 size={13} />}
            disabled={!project() || busy()}
            onSelect={() => void exportViaPandoc("docx")}
          />
          <OptionRow
            label="HTML"
            hint="Pandoc → standalone HTML — complex macros may not convert"
            icon={<FileCode size={13} />}
            disabled={!project() || busy()}
            onSelect={() => void exportViaPandoc("html")}
          />
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
