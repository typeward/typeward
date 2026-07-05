/**
 * CodeMirror 6 linter extension backed by Harper (Rust, in-process).
 *
 * Built on `@codemirror/lint` — the same primitive the LSP diagnostics use. We
 * debounce 400ms after typing pauses so the IPC isn't hammered mid-thought.
 * Each Harper diagnostic becomes a CM6 `Diagnostic` carrying:
 *  - a per-kind `markClass` (`cm-lint-<kind>`) so spelling / grammar / style
 *    underlines can be styled differently (see the theme CSS);
 *  - a kind chip prepended to the tooltip message;
 *  - up to three one-click replacement actions, plus "Add to dictionary"
 *    (spelling only) and "Ignore this lint".
 *
 * Every pass also mirrors its raw results into `grammar-store` so the Logs
 * panel's Grammar tab can show a cross-file view.
 *
 * Adapter wiring: LatexAdapter / TypstAdapter include this linter in
 * `cmExtensions()` only when `settings.integrations.grammar.enabled` is true.
 */

import { linter, forceLinting, type Action, type Diagnostic } from "@codemirror/lint";
import type { Extension } from "@codemirror/state";
import type { EditorView } from "@codemirror/view";

import * as ipc from "~/ipc";
import { setGrammarFileDiagnostics } from "~/stores/grammar-store";
import { familyForKind, familyMetaForKind, humanizeKind } from "./kinds";

const DEBOUNCE_MS = 400;

/**
 * A CM6 diagnostic carrying the stable Harper identity (`contextHash` + source
 * `line`) so panel actions can re-find the mapped live range instead of
 * recomputing offsets from stale line/col against a mutated buffer.
 */
export interface GrammarCmDiagnostic extends Diagnostic {
  contextHash: string;
  line: number;
}

export interface GrammarLinterOptions {
  /** Which Harper parser masks the markup (plain / markdown / latex / typst). */
  syntax: ipc.GrammarSyntax;
  /** Forwarded to the Rust side; populates Diagnostic.file. */
  file: string;
  /** English dialect (BCP-47); defaults to American on the Rust side. */
  dialect?: ipc.GrammarDialect;
}

export function harperLinter(opts: GrammarLinterOptions): Extension {
  return linter(
    async (view) => {
      const text = view.state.doc.toString();
      if (!text.trim()) {
        setGrammarFileDiagnostics(opts.file, []);
        return [];
      }
      let raw: ipc.GrammarDiagnostic[];
      try {
        raw = await ipc.grammarCheck(text, opts.file, opts.syntax, opts.dialect);
      } catch {
        return [];
      }
      // The editor remounts (destroying this view) on project/file switch. If
      // this check resolved after that, writing the cross-file grammar store
      // would re-populate an entry the switch just cleared — with another
      // project's diagnostics under a colliding relPath. Skip the write on a
      // detached view.
      if (!view.dom.isConnected) return [];
      setGrammarFileDiagnostics(opts.file, raw);
      return raw.map((d): GrammarCmDiagnostic => {
        const from = lineColToPos(view, d.line, d.col);
        const to = lineColToPos(view, d.endLine, d.endCol);
        return {
          from,
          to,
          severity: d.severity === "warning" ? "warning" : "info",
          message: d.message,
          source: d.source,
          markClass: `cm-lint-${d.kind.toLowerCase()}`,
          contextHash: d.contextHash,
          line: d.line,
          renderMessage: () => renderMessage(d),
          actions: buildActions(d),
        };
      });
    },
    { delay: DEBOUNCE_MS },
  );
}

function buildActions(d: ipc.GrammarDiagnostic): Action[] {
  const actions: Action[] = d.replacements
    .filter((r) => r.length > 0)
    .slice(0, 3)
    .map((replacement) => ({
      name: replacement,
      apply: (v: EditorView, a: number, b: number) => {
        v.dispatch({ changes: { from: a, to: b, insert: replacement } });
      },
    }));

  if (d.kind === "Spelling") {
    actions.push({
      name: "Add to dictionary",
      apply: (v: EditorView, a: number, b: number) => {
        const word = v.state.sliceDoc(a, b).trim();
        if (!word) return;
        void ipc
          .grammarAddWord(word)
          .then(() => forceLinting(v))
          .catch(() => {});
      },
    });
  }

  actions.push({
    name: "Ignore",
    apply: (v: EditorView) => {
      void ipc
        .grammarIgnoreLint(d.contextHash)
        .then(() => forceLinting(v))
        .catch(() => {});
    },
  });

  return actions;
}

function renderMessage(d: ipc.GrammarDiagnostic): Node {
  const wrap = document.createElement("div");
  wrap.className = "cm-lint-message";
  const family = familyForKind(d.kind);
  const chip = document.createElement("span");
  chip.className = `cm-lint-kind-chip cm-lint-kind-chip--${family}`;
  chip.style.setProperty("--dot", familyMetaForKind(d.kind).cssVar);
  chip.textContent = humanizeKind(d.kind);
  wrap.appendChild(chip);
  wrap.appendChild(document.createTextNode(d.message));
  return wrap;
}

export function lineColToPos(view: EditorView, line: number, col: number): number {
  const totalLines = view.state.doc.lines;
  const clampedLine = Math.max(1, Math.min(totalLines, line));
  const lineInfo = view.state.doc.line(clampedLine);
  const offset = Math.max(0, col - 1);
  return Math.min(lineInfo.to, lineInfo.from + offset);
}
