import {
  ArrowRightToLine,
  Expand,
  Lightbulb,
  MessageCircleQuestion,
  PenLine,
  Shrink,
  SpellCheck,
} from "lucide-solid";
import type { Component } from "solid-js";

import type { EditorCommand } from "~/adapters/types";
import { registerEditorMenuAction } from "~/components/editor/context-menu/registry";
import { registerCommand } from "~/commands/registry";
import {
  AI_ACTIONS,
  type AiActionId,
  aiAssistantEnabled,
  runAiAction,
} from "~/integrations/ai/actions";
import { activeFile } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";

/**
 * Wires the AI action defs into both consumers: palette `EditorCommand`s and
 * the editor context-menu registry — each behind the identical visibility
 * predicate `aiAssistantEnabled() && (!needsSelection || hasSelection())`.
 * Both the palette and the menu drop entries whose `when` fails, so with the
 * assistant off the AI section simply doesn't exist.
 */

const ACTION_ICONS: Record<AiActionId, Component<{ size?: number; class?: string }>> = {
  "ai.rewrite": PenLine,
  "ai.fixGrammar": SpellCheck,
  "ai.makeConcise": Shrink,
  "ai.expand": Expand,
  "ai.continueWriting": ArrowRightToLine,
  "ai.explain": Lightbulb,
  "ai.askSelection": MessageCircleQuestion,
};

function editorHasSelection(): boolean {
  const view = getActiveEditorView();
  if (!view) return false;
  const sel = view.state.selection.main;
  return sel.from !== sel.to;
}

let registered = false;

/** Idempotent — called once from App boot next to the other AI init. */
export function registerAiEditorActions(): void {
  if (registered) return;
  registered = true;

  AI_ACTIONS.forEach((def, i) => {
    const command: EditorCommand = {
      id: def.id,
      title: def.title,
      subtitle: def.subtitle,
      group: "AI",
      scope: "editor",
      when: () =>
        aiAssistantEnabled() &&
        activeFile() !== null &&
        getActiveEditorView() !== null &&
        (!def.needsSelection || editorHasSelection()),
      run: () => {
        runAiAction(def.id);
      },
    };
    registerCommand(command);

    registerEditorMenuAction({
      id: def.id,
      label: def.label,
      icon: ACTION_ICONS[def.id],
      group: "ai",
      order: i,
      when: (ctx) =>
        aiAssistantEnabled() && (!def.needsSelection || ctx.hasSelection),
      run: () => {
        runAiAction(def.id);
      },
    });
  });
}
