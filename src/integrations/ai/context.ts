/**
 * Context assembly for the AI editor actions — a pure module (no IPC, no
 * stores): given the editor state and an action spec, it produces the exact
 * outbound message list. Everything sent is enumerated and capped here;
 * nothing else about the project (paths, names, sibling files) is included.
 */

import type { EditorLanguage } from "~/adapters/languages";
import type { Diagnostic } from "~/adapters/types";
import type { ChatMessage } from "~/integrations/types";

export const SELECTION_CAP = 16 * 1024;
export const SURROUND_LINES = 40;
export const SURROUND_CAP = 3 * 1024;
export const PREAMBLE_CAP = 4 * 1024;
export const DIAGNOSTIC_CAP = 4 * 1024;

export interface ActionContextInput {
  /** Full document text at invoke time. */
  doc: string;
  /** Selection offsets (equal = cursor only). */
  from: number;
  to: number;
  language: EditorLanguage;
  /** Last compile diagnostics for the active file ("Explain this" only). */
  diagnostics?: Diagnostic[];
  /** Raw compile log ("Explain this" only; excerpted + capped). */
  log?: string;
}

export interface AssembledContext {
  language: EditorLanguage;
  /** Selection text, capped to {@link SELECTION_CAP}. */
  selection: string;
  /** Lines above/below the selection: ±{@link SURROUND_LINES}, capped each side. */
  before: string;
  after: string;
  /** File preamble — LaTeX: up to \begin{document}; Typst: the leading
   *  #import/#set block; markdown/plain: none. Capped. */
  preamble: string;
  /** Overlapping compile diagnostic + log excerpt, capped; null when none. */
  diagnostic: string | null;
  hasSelection: boolean;
}

/** Minimal structural view of an action def — actions.ts extends this. */
export interface ActionPromptSpec {
  id: string;
  kind: "transform" | "continue" | "answer";
  buildPrompt(ctx: AssembledContext): string;
}

function lineNumberAt(doc: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < doc.length; i++) {
    if (doc.charCodeAt(i) === 10) line++;
  }
  return line;
}

function surroundingBefore(doc: string, from: number): string {
  const head = doc.slice(0, from);
  const lines = head.split("\n");
  // The line the selection starts on is part of the selection context, not
  // the surround — take complete lines above it.
  const above = lines.slice(0, -1).slice(-SURROUND_LINES).join("\n");
  return above.length > SURROUND_CAP ? above.slice(above.length - SURROUND_CAP) : above;
}

function surroundingAfter(doc: string, to: number): string {
  const tail = doc.slice(to);
  const lines = tail.split("\n");
  const below = lines.slice(1, 1 + SURROUND_LINES).join("\n");
  return below.length > SURROUND_CAP ? below.slice(0, SURROUND_CAP) : below;
}

function extractPreamble(doc: string, language: EditorLanguage): string {
  if (language === "latex") {
    const idx = doc.indexOf("\\begin{document}");
    if (idx <= 0) return "";
    const preamble = doc.slice(0, idx).trimEnd();
    return preamble.length > PREAMBLE_CAP ? preamble.slice(0, PREAMBLE_CAP) : preamble;
  }
  if (language === "typst") {
    const lines = doc.split("\n");
    const kept: string[] = [];
    for (const line of lines) {
      const trimmed = line.trim();
      if (
        trimmed === "" ||
        trimmed.startsWith("#import") ||
        trimmed.startsWith("#set") ||
        trimmed.startsWith("//")
      ) {
        kept.push(line);
        continue;
      }
      break;
    }
    const preamble = kept.join("\n").trim();
    return preamble.length > PREAMBLE_CAP ? preamble.slice(0, PREAMBLE_CAP) : preamble;
  }
  return "";
}

function overlappingDiagnostics(
  input: ActionContextInput,
  startLine: number,
  endLine: number,
): string | null {
  const hits = (input.diagnostics ?? []).filter((d) => {
    const dStart = d.line;
    const dEnd = d.endLine ?? d.line;
    return dEnd >= startLine && dStart <= endLine;
  });
  if (hits.length === 0) return null;
  let text = hits
    .map((d) => `${d.severity}: ${d.message} (line ${d.line})`)
    .join("\n");
  if (input.log && text.length < DIAGNOSTIC_CAP) {
    const budget = DIAGNOSTIC_CAP - text.length - 24;
    if (budget > 0) {
      const excerpt =
        input.log.length > budget
          ? input.log.slice(input.log.length - budget)
          : input.log;
      text += `\n--- log excerpt ---\n${excerpt}`;
    }
  }
  return text.length > DIAGNOSTIC_CAP ? text.slice(0, DIAGNOSTIC_CAP) : text;
}

export function assembleContext(input: ActionContextInput): AssembledContext {
  const from = Math.max(0, Math.min(input.doc.length, input.from));
  const to = Math.max(from, Math.min(input.doc.length, input.to));
  const rawSelection = input.doc.slice(from, to);
  const selection =
    rawSelection.length > SELECTION_CAP
      ? rawSelection.slice(0, SELECTION_CAP)
      : rawSelection;
  const startLine = lineNumberAt(input.doc, from);
  const endLine = lineNumberAt(input.doc, to);
  return {
    language: input.language,
    selection,
    before: surroundingBefore(input.doc, from),
    after: surroundingAfter(input.doc, to),
    preamble: extractPreamble(input.doc, input.language),
    diagnostic: overlappingDiagnostics(input, startLine, endLine),
    hasSelection: from !== to,
  };
}

export function languageLabel(language: EditorLanguage): string {
  switch (language) {
    case "latex":
      return "LaTeX";
    case "typst":
      return "Typst";
    case "markdown":
      return "Markdown";
    default:
      return "plain text";
  }
}

const TRANSFORM_SYSTEM =
  "You are a writing assistant embedded in a document editor. Reply with only the replacement text - no commentary, no surrounding code fences, no quotes. Preserve the document's markup, commands, and formatting conventions exactly where they are not the target of the edit.";

const CONTINUE_SYSTEM =
  "You are a writing assistant embedded in a document editor. Reply with only the text to insert at the cursor - no commentary, no code fences. Continue seamlessly from the surrounding context, matching its language, tone, and markup.";

function section(title: string, body: string): string {
  return `${title}:\n"""\n${body}\n"""`;
}

/**
 * The exact outbound message list for an action. Transform/continue actions
 * get a system message that pins the reply to raw replacement text; "answer"
 * actions are routed into the chat pane, so everything rides in one visible
 * user message (what the user sees is what was sent).
 */
export function buildActionMessages(
  spec: ActionPromptSpec,
  ctx: AssembledContext,
): ChatMessage[] {
  const parts: string[] = [spec.buildPrompt(ctx)];
  parts.push(`Language: ${languageLabel(ctx.language)}`);
  if (ctx.preamble) parts.push(section("Document preamble (context only)", ctx.preamble));
  if (ctx.before) parts.push(section("Text before the selection (context only)", ctx.before));
  if (ctx.after) parts.push(section("Text after the selection (context only)", ctx.after));
  if (ctx.hasSelection) parts.push(section("Selection", ctx.selection));
  if (ctx.diagnostic) {
    parts.push(section("Compiler diagnostics overlapping the selection", ctx.diagnostic));
  }
  const user: ChatMessage = { role: "user", content: parts.join("\n\n") };

  if (spec.kind === "transform") {
    return [{ role: "system", content: TRANSFORM_SYSTEM }, user];
  }
  if (spec.kind === "continue") {
    return [{ role: "system", content: CONTINUE_SYSTEM }, user];
  }
  return [user];
}
