/**
 * CodeMirror 6 linter extension backed by Harper (Rust, in-process).
 *
 * Built on `@codemirror/lint` — the same primitive the LSP diagnostics
 * use. We debounce 400ms after typing pauses so the IPC isn't
 * hammered while the user is mid-thought. Each Harper diagnostic
 * becomes a CM6 `Diagnostic` with a one-click apply action per
 * suggested replacement.
 *
 * Adapter wiring: LatexAdapter / TypstAdapter include `grammarLinter`
 * in `cmExtensions()` only when `settings.integrations.grammar.enabled`
 * is true (Phase 5.2 hooks into the adapter contract there).
 */

import { linter, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";

import * as ipc from "~/ipc";

const DEBOUNCE_MS = 400;

export interface GrammarLinterOptions {
  /** Forwarded to the Rust side; informational only for now. */
  syntax: ipc.GrammarSyntax;
  /** Forwarded to the Rust side; populates Diagnostic.file. */
  file: string;
}

export function harperLinter(opts: GrammarLinterOptions): Extension {
  return linter(
    async (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) return [];
      let raw: ipc.GrammarDiagnostic[];
      try {
        raw = await ipc.grammarCheck(text, opts.file, opts.syntax);
      } catch {
        return [];
      }
      return raw.map((d): Diagnostic => {
        const from = lineColToPos(view, d.line, d.col);
        const to = lineColToPos(view, d.endLine, d.endCol);
        return {
          from,
          to,
          severity: d.severity === "warning" ? "warning" : "info",
          message: d.message,
          source: d.source,
          actions: d.replacements
            .filter((r) => r.length > 0)
            .slice(0, 3)
            .map((replacement) => ({
              name: replacement,
              apply: (v, a, b) => {
                v.dispatch({
                  changes: { from: a, to: b, insert: replacement },
                });
              },
            })),
        };
      });
    },
    { delay: DEBOUNCE_MS },
  );
}

function lineColToPos(
  view: import("@codemirror/view").EditorView,
  line: number,
  col: number,
): number {
  const totalLines = view.state.doc.lines;
  const clampedLine = Math.max(1, Math.min(totalLines, line));
  const lineInfo = view.state.doc.line(clampedLine);
  const offset = Math.max(0, col - 1);
  return Math.min(lineInfo.to, lineInfo.from + offset);
}
