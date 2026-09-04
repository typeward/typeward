/**
 * The selection-driven AI editor actions — defined as data, consumed twice:
 * registered as palette `EditorCommand`s and as editor context-menu items
 * (see `editor-actions.ts`). Transform/continue actions stream into the
 * lazy `AiActionDialog` (diff preview -> Replace / Insert / Copy); "answer"
 * actions route into the chat pane. Nothing is sent anywhere except from an
 * explicit invocation of one of these actions.
 */

import { languageForFile } from "~/adapters/languages";
import { quoteForDraft } from "~/integrations/ai/chat-text";
import {
  type AssembledContext,
  type ActionPromptSpec,
  assembleContext,
  buildActionMessages,
  languageLabel,
} from "~/integrations/ai/context";
import { setRequestAiAction } from "~/commands/palette-store";
import { notifyError } from "~/lib/toast";
import {
  sendChatMessage,
  setChatDraft,
} from "~/stores/ai-chat-store";
import { activeFile, lastResult } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { integrationsSettings } from "~/stores/settings-store";
import { setPreviewMode } from "~/stores/ui-store";
import { isTabletViewport, setActivePane } from "~/stores/viewport-store";

export type AiActionId =
  | "ai.rewrite"
  | "ai.fixGrammar"
  | "ai.makeConcise"
  | "ai.expand"
  | "ai.continueWriting"
  | "ai.explain"
  | "ai.askSelection";

export type AiActionKind = "transform" | "continue" | "answer";

export interface AiActionDef extends ActionPromptSpec {
  id: AiActionId;
  label: string;
  /** Palette title (imperative, matches the command-palette voice). */
  title: string;
  subtitle?: string;
  needsSelection: boolean;
  kind: AiActionKind;
}

/**
 * The one visibility predicate every AI surface derives from (chat pane,
 * bubble actions, attach UI, palette commands, context-menu items, the
 * action dialog trigger) — they render nothing when false.
 */
export function aiAssistantEnabled(): boolean {
  return integrationsSettings().ai.enabled;
}

export const AI_ACTIONS: AiActionDef[] = [
  {
    id: "ai.rewrite",
    label: "Rewrite",
    title: "Rewrite selection",
    subtitle: "Rewrite the selected text for clarity and flow",
    needsSelection: true,
    kind: "transform",
    buildPrompt: () =>
      "Rewrite the selected text to improve clarity, flow, and style. Keep the meaning and keep all markup valid.",
  },
  {
    id: "ai.fixGrammar",
    label: "Fix grammar & style",
    title: "Fix grammar & style in selection",
    // Complementary to Harper: Harper is deterministic on-device lints; this
    // is an LLM rewrite through the user's provider. Neither replaces the other.
    subtitle: "LLM rewrite via your AI provider, complementing Harper's on-device lints",
    needsSelection: true,
    kind: "transform",
    buildPrompt: () =>
      "Fix grammar, spelling, punctuation, and awkward style in the selected text. Make only necessary corrections - keep the author's voice, structure, and markup otherwise untouched.",
  },
  {
    id: "ai.makeConcise",
    label: "Make concise",
    title: "Make selection concise",
    subtitle: "Tighten the selected text without losing information",
    needsSelection: true,
    kind: "transform",
    buildPrompt: () =>
      "Make the selected text more concise. Remove redundancy and filler without losing information or changing the meaning; keep the markup valid.",
  },
  {
    id: "ai.expand",
    label: "Expand",
    title: "Expand selection",
    subtitle: "Elaborate on the selected text in the surrounding tone",
    needsSelection: true,
    kind: "transform",
    buildPrompt: () =>
      "Expand the selected text with more detail and supporting sentences. Match the surrounding tone and style; keep the markup valid.",
  },
  {
    id: "ai.continueWriting",
    label: "Continue writing",
    title: "Continue writing from cursor",
    subtitle: "Draft the next passage from the cursor position",
    needsSelection: false,
    kind: "continue",
    buildPrompt: () =>
      "Continue writing from the cursor position. Produce the next passage so it reads as a seamless continuation of the text before the cursor.",
  },
  {
    id: "ai.explain",
    label: "Explain this",
    title: "Explain selection",
    subtitle: "Explain the selected construct (and any compile error under it)",
    needsSelection: true,
    kind: "answer",
    buildPrompt: (ctx: AssembledContext) =>
      ctx.diagnostic
        ? `Explain this ${languageLabel(ctx.language)} code and the compiler diagnostics reported for it, then suggest a fix.`
        : `Explain what this ${languageLabel(ctx.language)} code does, briefly and concretely.`,
  },
  {
    id: "ai.askSelection",
    label: "Ask about selection",
    title: "Ask about selection",
    subtitle: "Open the chat with the selection quoted, ready for your question",
    needsSelection: true,
    kind: "answer",
    // Never sent as-is — the run handler quotes the selection into the chat
    // draft and the user types the actual question.
    buildPrompt: () => "",
  },
];

export function aiActionById(id: AiActionId): AiActionDef {
  return AI_ACTIONS.find((a) => a.id === id)!;
}

function openChatPane(): void {
  setPreviewMode("ai");
  if (isTabletViewport()) setActivePane("preview");
}

let requestGen = 0;

/**
 * Invoke an action against the current editor state. Captures the selection
 * snapshot at invoke time (the dialog's stale-selection guard verifies it
 * again before Replace) and assembles the capped context — the only content
 * that leaves the machine, and only via the explicit provider request that
 * follows.
 */
export function runAiAction(id: AiActionId): void {
  const def = aiActionById(id);
  if (!aiAssistantEnabled()) return;
  const view = getActiveEditorView();
  const file = activeFile();
  if (!view || !file) return;
  const sel = view.state.selection.main;
  if (def.needsSelection && sel.from === sel.to) return;

  const isExplain = def.id === "ai.explain";
  const compile = isExplain ? lastResult() : null;
  const ctx = assembleContext({
    doc: view.state.doc.toString(),
    from: sel.from,
    to: sel.to,
    language: languageForFile(file.relPath),
    diagnostics: isExplain
      ? (compile?.diagnostics ?? []).filter((d) => d.file === file.relPath)
      : undefined,
    log: isExplain ? compile?.log : undefined,
  });

  if (def.kind === "answer") {
    openChatPane();
    if (def.id === "ai.askSelection") {
      setChatDraft(quoteForDraft(ctx.selection));
      return;
    }
    const [user] = buildActionMessages(def, ctx);
    void sendChatMessage(user.content).catch((e) => {
      notifyError("AI request failed", e instanceof Error ? e.message : String(e));
    });
    return;
  }

  setRequestAiAction({
    actionId: def.id,
    kind: def.kind,
    label: def.label,
    messages: buildActionMessages(def, ctx),
    snapshot: {
      from: sel.from,
      to: sel.to,
      text: view.state.doc.sliceString(sel.from, sel.to),
    },
    generation: ++requestGen,
  });
}

/**
 * Chat bubble "Apply to selection": open the same diff preview against the
 * current editor selection with an already-final result — no request is
 * sent. Returns false when there is no selection to apply to.
 */
export function applyChatTextToSelection(text: string): boolean {
  const view = getActiveEditorView();
  if (!view) return false;
  const sel = view.state.selection.main;
  if (sel.from === sel.to) return false;
  setRequestAiAction({
    actionId: "ai.applyFromChat",
    kind: "transform",
    label: "Apply to selection",
    messages: [],
    snapshot: {
      from: sel.from,
      to: sel.to,
      text: view.state.doc.sliceString(sel.from, sel.to),
    },
    presetResult: text,
    generation: ++requestGen,
  });
  return true;
}
