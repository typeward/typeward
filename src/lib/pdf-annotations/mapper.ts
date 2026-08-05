import { createEffect, createSignal, onCleanup } from "solid-js";
import type { Project } from "~/adapters/types";
import type { CommentThread } from "~/lib/reviews/types";
import { offsetToLine } from "~/lib/reviews/lines";
import { mapLimit } from "~/integrations/references/concurrency";
import type { PdfAnnotation } from "~/lib/pdf-annotations/types";

/** Cap the number of threads we SyncTeX-forward per pass — each is a subprocess
 *  spawn on the CLI engine, so an unbounded review set shouldn't storm it. */
const MAX_ANNOTATIONS = 200;

export interface PdfAnnotationDeps {
  /** Only map while the PDF is actually on screen for a SyncTeX-capable project. */
  enabled: () => boolean;
  /** Open threads to place (across all files). */
  threads: () => CommentThread[];
  project: () => Project | null;
  /** Compiled PDF path (identity gate). */
  outputPath: () => string | null;
  /** Recompile bumps this → every thread re-resolves against the fresh PDF. */
  pdfVersion: () => number;
  /** Source text for a file — buffer-preferred, disk fallback; null if unreadable. */
  getContent: (relPath: string) => Promise<string | null>;
  /** SyncTeX forward (source line → page + y + optional hbox), engine-resolved
   *  by the caller. */
  resolveForward: (
    p: Project,
    outputPath: string,
    relPath: string,
    line: number,
  ) => Promise<{
    page: number;
    y: number;
    box?: { left: number; top: number; width: number; height: number } | null;
  } | null>;
}

/**
 * Resolve open review/TODO threads to PDF locations for in-PDF highlighting.
 * Runs a bounded-concurrency SyncTeX-forward pass keyed on (pdfVersion, file,
 * offset, anchorText) so unchanged threads never re-spawn synctex, and drops
 * stale async results via a generation guard. Idle (empty) while the PDF isn't
 * showing. Returns a reactive accessor of the current annotation set.
 */
export function createPdfAnnotations(deps: PdfAnnotationDeps): () => PdfAnnotation[] {
  const [annotations, setAnnotations] = createSignal<PdfAnnotation[]>([]);
  const cache = new Map<string, { key: string; ann: PdfAnnotation | null }>();
  let gen = 0;

  createEffect(() => {
    const enabled = deps.enabled();
    const threads = deps.threads();
    const p = deps.project();
    const out = deps.outputPath();
    const ver = deps.pdfVersion();
    if (!enabled || !p || !out) {
      // Invalidate any in-flight pass too — otherwise its late setAnnotations
      // (runGen still === gen) would clobber this clear with stale annotations
      // after an in-place disable (open a .md tab, switch to console, or a
      // project/format change that doesn't unmount the mapper).
      gen++;
      setAnnotations([]);
      return;
    }
    const runGen = ++gen;
    const targets = threads.slice(0, MAX_ANNOTATIONS);
    void (async () => {
      const results = await mapLimit(targets, 2, async (t) => {
        const key = `${ver}:${t.fileRelPath}:${t.fromOffset}:${t.anchorText}`;
        const cached = cache.get(t.id);
        if (cached && cached.key === key) return cached.ann;
        const content = await deps.getContent(t.fileRelPath);
        if (runGen !== gen) return null;
        if (content === null) {
          cache.set(t.id, { key, ann: null });
          return null;
        }
        const line = offsetToLine(content, t.fromOffset);
        const loc = await deps.resolveForward(p, out, t.fileRelPath, line);
        if (runGen !== gen) return null;
        const ann: PdfAnnotation | null = loc
          ? {
              threadId: t.id,
              kind: t.kind === "todo" ? "todo" : "comment",
              page: loc.page,
              y: loc.y,
              box: loc.box ?? null,
              anchorText: t.anchorText,
            }
          : null;
        cache.set(t.id, { key, ann });
        return ann;
      });
      if (runGen !== gen) return;
      const live = new Set(targets.map((t) => t.id));
      for (const id of [...cache.keys()]) if (!live.has(id)) cache.delete(id);
      setAnnotations(results.filter((a): a is PdfAnnotation => a !== null));
    })();
  });

  onCleanup(() => {
    gen++;
    cache.clear();
  });

  return annotations;
}
