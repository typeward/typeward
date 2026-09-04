/**
 * Small pure text helpers shared by the chat pane and the editor actions.
 */

const FENCE_RE = /```[^\n]*\n([\s\S]*?)```/g;

/**
 * What "Insert at cursor" inserts for an assistant message: when the message
 * contains exactly one fenced code block, the block body (the usual "here's
 * your fixed snippet" reply shape); otherwise the whole text.
 */
export function extractInsertText(content: string): string {
  const matches = [...content.matchAll(FENCE_RE)];
  if (matches.length === 1) {
    return matches[0][1].replace(/\n$/, "");
  }
  return content;
}

/** Quote a selection into the chat draft (the "Ask about selection" seed). */
export function quoteForDraft(selection: string): string {
  const quoted = selection
    .replace(/\s+$/, "")
    .split("\n")
    .map((l) => `> ${l}`)
    .join("\n");
  return `${quoted}\n\n`;
}
