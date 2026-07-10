import { describe, expect, it, vi } from "vitest";

// actions.ts pulls stores + registry transitively; the prompt builders under
// test are pure, so stub the heavy seams out (mock the providers per plan).
vi.mock("~/stores/ai-chat-store", () => ({
  sendChatMessage: vi.fn(async () => {}),
  setChatDraft: vi.fn(),
}));
vi.mock("~/stores/settings-store", () => ({
  integrationsSettings: () => ({ ai: { enabled: true, perProviderModel: {} } }),
}));
vi.mock("~/integrations/ai/registry", () => ({
  hasAnyAiEntitlement: () => true,
  activeProvider: () => null,
  activeProviderId: () => null,
}));
vi.mock("~/stores/editor-store", () => ({
  activeFile: () => null,
  lastResult: () => null,
}));
vi.mock("~/stores/editor-view-store", () => ({
  getActiveEditorView: () => null,
}));

import type { Diagnostic } from "~/adapters/types";
import { AI_ACTIONS, aiActionById } from "./actions";
import {
  DIAGNOSTIC_CAP,
  PREAMBLE_CAP,
  SELECTION_CAP,
  SURROUND_CAP,
  SURROUND_LINES,
  assembleContext,
  buildActionMessages,
} from "./context";

const LATEX_DOC = [
  "\\documentclass{article}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "Intro line.",
  "Selected sentence here.",
  "Outro line.",
  "\\end{document}",
].join("\n");

function offsetsOf(doc: string, needle: string): { from: number; to: number } {
  const from = doc.indexOf(needle);
  return { from, to: from + needle.length };
}

describe("assembleContext", () => {
  it("captures selection, surround, and the LaTeX preamble", () => {
    const { from, to } = offsetsOf(LATEX_DOC, "Selected sentence here.");
    const ctx = assembleContext({ doc: LATEX_DOC, from, to, language: "latex" });
    expect(ctx.selection).toBe("Selected sentence here.");
    expect(ctx.hasSelection).toBe(true);
    expect(ctx.before.endsWith("Intro line.")).toBe(true);
    expect(ctx.after.startsWith("Outro line.")).toBe(true);
    expect(ctx.preamble).toBe(
      "\\documentclass{article}\n\\usepackage{amsmath}",
    );
    expect(ctx.diagnostic).toBeNull();
  });

  it("caps the selection at 16 KB", () => {
    const big = "x".repeat(SELECTION_CAP + 500);
    const ctx = assembleContext({ doc: big, from: 0, to: big.length, language: "plain" });
    expect(ctx.selection.length).toBe(SELECTION_CAP);
  });

  it("caps the surround at ±40 lines and 3 KB per side", () => {
    const lines = Array.from({ length: 200 }, (_, i) => `line ${i}`);
    const doc = lines.join("\n");
    const { from, to } = offsetsOf(doc, "line 100");
    const ctx = assembleContext({ doc, from, to, language: "plain" });
    expect(ctx.before.split("\n").length).toBe(SURROUND_LINES);
    expect(ctx.before.split("\n")[0]).toBe("line 60");
    expect(ctx.after.split("\n").length).toBe(SURROUND_LINES);
    expect(ctx.after.split("\n")[0]).toBe("line 101");

    const longLines = Array.from({ length: 90 }, () => "y".repeat(200)).join("\n");
    const mid = Math.floor(longLines.length / 2);
    const capped = assembleContext({
      doc: longLines,
      from: mid,
      to: mid + 1,
      language: "plain",
    });
    expect(capped.before.length).toBeLessThanOrEqual(SURROUND_CAP);
    expect(capped.after.length).toBeLessThanOrEqual(SURROUND_CAP);
  });

  it("caps the preamble at 4 KB", () => {
    const doc = `${"%".repeat(PREAMBLE_CAP + 800)}\n\\begin{document}\nbody\n\\end{document}`;
    const { from, to } = offsetsOf(doc, "body");
    const ctx = assembleContext({ doc, from, to, language: "latex" });
    expect(ctx.preamble.length).toBe(PREAMBLE_CAP);
  });

  it("extracts the leading #import/#set block for Typst and none for markdown", () => {
    const typst = [
      '#import "@preview/thing:0.1.0": *',
      "#set page(margin: 1in)",
      "",
      "= Heading",
      "Body text",
    ].join("\n");
    const { from, to } = offsetsOf(typst, "Body text");
    const ctx = assembleContext({ doc: typst, from, to, language: "typst" });
    expect(ctx.preamble).toBe(
      '#import "@preview/thing:0.1.0": *\n#set page(margin: 1in)',
    );

    const md = assembleContext({ doc: "# Title\n\ntext", from: 9, to: 13, language: "markdown" });
    expect(md.preamble).toBe("");
  });

  it("includes only diagnostics whose lines overlap the selection, log capped", () => {
    const diagnostics: Diagnostic[] = [
      { severity: "error", message: "Undefined control sequence", file: "main.tex", line: 5 },
      { severity: "warning", message: "elsewhere", file: "main.tex", line: 50 },
    ];
    const { from, to } = offsetsOf(LATEX_DOC, "Selected sentence here."); // line 5
    const ctx = assembleContext({
      doc: LATEX_DOC,
      from,
      to,
      language: "latex",
      diagnostics,
      log: "L".repeat(DIAGNOSTIC_CAP * 2),
    });
    expect(ctx.diagnostic).toContain("Undefined control sequence");
    expect(ctx.diagnostic).not.toContain("elsewhere");
    expect(ctx.diagnostic!.length).toBeLessThanOrEqual(DIAGNOSTIC_CAP);
  });
});

describe("action definitions", () => {
  it("declares the seven actions with the planned selection/kind matrix", () => {
    expect(AI_ACTIONS.map((a) => [a.id, a.kind, a.needsSelection])).toEqual([
      ["ai.rewrite", "transform", true],
      ["ai.fixGrammar", "transform", true],
      ["ai.makeConcise", "transform", true],
      ["ai.expand", "transform", true],
      ["ai.continueWriting", "continue", false],
      ["ai.explain", "answer", true],
      ["ai.askSelection", "answer", true],
    ]);
  });
});

describe("buildActionMessages", () => {
  const { from, to } = offsetsOf(LATEX_DOC, "Selected sentence here.");
  const ctx = assembleContext({ doc: LATEX_DOC, from, to, language: "latex" });

  it("builds system + user for transforms, with the instruction and selection", () => {
    const messages = buildActionMessages(aiActionById("ai.rewrite"), ctx);
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toContain("only the replacement text");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toContain("Rewrite the selected text");
    expect(messages[1].content).toContain("Language: LaTeX");
    expect(messages[1].content).toContain("Selected sentence here.");
    // Never sent: file paths / project names — the content is exactly the
    // enumerated sections.
    expect(messages[1].content).not.toContain("main.tex");
  });

  it("omits temperature/maxTokens concerns — messages only", () => {
    // (The dialog passes only { model, signal }; asserted here structurally:
    // builders return plain messages with no options attached.)
    const messages = buildActionMessages(aiActionById("ai.makeConcise"), ctx);
    for (const m of messages) {
      expect(Object.keys(m).sort()).toEqual(["content", "role"]);
    }
  });

  it("builds a continue prompt without a selection section", () => {
    const cursorCtx = assembleContext({
      doc: LATEX_DOC,
      from,
      to: from,
      language: "latex",
    });
    const messages = buildActionMessages(
      aiActionById("ai.continueWriting"),
      cursorCtx,
    );
    expect(messages[0].content).toContain("text to insert at the cursor");
    expect(messages[1].content).not.toContain("Selection:");
  });

  it("builds a single visible user message for answer actions", () => {
    const withDiag = {
      ...ctx,
      diagnostic: "error: Undefined control sequence (line 5)",
    };
    const messages = buildActionMessages(aiActionById("ai.explain"), withDiag);
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("compiler diagnostics");
    expect(messages[0].content).toContain("Undefined control sequence");
  });
});
