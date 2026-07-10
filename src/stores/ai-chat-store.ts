import { createEffect, createRoot, createSignal, on } from "solid-js";

import type { AiProvider } from "~/integrations/types";
import type { ChatAttachment } from "~/integrations/types";
import {
  MAX_REQUEST_BASE64_BYTES,
  formatBytes,
  totalAttachmentBase64Bytes,
} from "~/integrations/ai/attachments";
import { activeProvider, type AiProviderId } from "~/integrations/ai/registry";
import { describeIpcError } from "~/lib/errors";
import { recordError } from "~/lib/telemetry";
import * as ipc from "~/ipc";
import { project } from "~/stores/editor-store";
import { integrationsSettings } from "~/stores/settings-store";
import {
  type ChatTurn,
  type Conversation,
  deriveTitle,
  makeChatId,
  parseConversation,
  serializeConversation,
} from "~/stores/ai-chat-jsonl";

export type { ChatTurn, Conversation };

/**
 * AI chat state, owned at module scope (the review-store shape) so a pane
 * switch no longer kills a generation — `AiView` is render-only. Streaming,
 * stop/regenerate, and JSONL persistence all live here.
 *
 * Persistence: `<project>/.typeward/ai/conversations/<id>.jsonl` via the
 * project-file IPC funnel. `.typeward/` is watcher-filtered, git-excluded,
 * and rejected by cloud sync, so conversations generate zero churn and never
 * leave the machine. No project open → in-memory only.
 */

const CONVERSATIONS_DIR = ".typeward/ai/conversations";
const SAVE_DEBOUNCE_MS = 1_000;
/** Newest N conversations kept per project; pruned on create. */
const MAX_CONVERSATIONS = 30;

const [conversations, setConversations] = createSignal<Conversation[]>([]);
const [activeConversationId, setActiveConversationId] = createSignal<string | null>(null);
const [chatStreaming, setChatStreaming] = createSignal(false);
const [chatStreamingText, setChatStreamingText] = createSignal("");
/** Which conversation the running stream belongs to (guards the live bubble). */
const [streamingConversationId, setStreamingConversationId] = createSignal<string | null>(null);
const [chatError, setChatError] = createSignal<string | null>(null);
/** Composer draft — in the store so "Ask about selection" can prefill it. */
const [chatDraft, setChatDraft] = createSignal("");
/** Composer attachments (full payloads; stubbed at persistence time). */
const [pendingAttachments, setPendingAttachments] = createSignal<ChatAttachment[]>([]);

let abortController: AbortController | null = null;
let loadedRoot: string | null = null;
let loadSeq = 0;

// Debounced writes: conversation ids dirtied since the last flush, with the
// root captured at schedule time (a debounce can outlive a project switch).
const dirtyConversations = new Map<string, string>();
let saveTimer: ReturnType<typeof setTimeout> | null = null;

function conversationRelPath(id: string): string {
  return `${CONVERSATIONS_DIR}/${id}.jsonl`;
}

function activeConversation(): Conversation | null {
  const id = activeConversationId();
  if (!id) return null;
  return conversations().find((c) => c.id === id) ?? null;
}

/** Load the sidecar dir once per project; lazy — called on pane mount. */
async function ensureConversationsLoaded(): Promise<void> {
  const proj = project();
  if (!proj || loadedRoot === proj.rootPath) return;
  loadedRoot = proj.rootPath;
  const seq = ++loadSeq;

  let names: string[] = [];
  try {
    const { readDir } = await import("@tauri-apps/plugin-fs");
    const entries = await readDir(`${proj.rootPath}/${CONVERSATIONS_DIR}`);
    names = entries
      .filter((e) => e.isFile && e.name.endsWith(".jsonl"))
      .map((e) => e.name);
  } catch {
    // No sidecar dir yet — nothing on disk; keep whatever was started
    // in-memory while the load was in flight.
    return;
  }

  const loaded: Conversation[] = [];
  for (const name of names) {
    try {
      const raw = await ipc.readProjectTextFile(
        proj.rootPath,
        `${CONVERSATIONS_DIR}/${name}`,
      );
      const conv = parseConversation(raw);
      if (conv) loaded.push(conv);
    } catch (e) {
      recordError("ai-chat-load", `reading ${name} failed`, e);
    }
  }
  if (seq !== loadSeq) return;
  // Merge under any conversation created while the load was in flight —
  // in-memory state wins by id (it is newer than its own sidecar).
  setConversations((prev) => {
    const existingIds = new Set(prev.map((c) => c.id));
    const merged = [...prev, ...loaded.filter((c) => !existingIds.has(c.id))];
    merged.sort((a, b) => b.updatedAt - a.updatedAt);
    return merged.slice(0, MAX_CONVERSATIONS);
  });
}

function newConversation(): Conversation {
  const now = Date.now();
  const conv: Conversation = {
    id: makeChatId(),
    title: "New conversation",
    createdAt: now,
    updatedAt: now,
    turns: [],
  };
  setConversations((prev) => [conv, ...prev]);
  setActiveConversationId(conv.id);
  setChatError(null);
  pruneOldConversations();
  return conv;
}

function selectConversation(id: string): void {
  if (conversations().some((c) => c.id === id)) {
    setActiveConversationId(id);
    setChatError(null);
  }
}

async function deleteConversation(id: string): Promise<void> {
  const proj = project();
  setConversations((prev) => prev.filter((c) => c.id !== id));
  dirtyConversations.delete(id);
  if (activeConversationId() === id) setActiveConversationId(null);
  if (proj) {
    try {
      const { remove } = await import("@tauri-apps/plugin-fs");
      await remove(`${proj.rootPath}/${conversationRelPath(id)}`);
    } catch {
      // Never persisted (or already gone) — nothing to delete.
    }
  }
}

/** Retention: keep the newest MAX_CONVERSATIONS, delete the rest's files. */
function pruneOldConversations(): void {
  const all = conversations();
  if (all.length <= MAX_CONVERSATIONS) return;
  const sorted = [...all].sort((a, b) => b.updatedAt - a.updatedAt);
  const pruned = sorted.slice(MAX_CONVERSATIONS);
  setConversations(sorted.slice(0, MAX_CONVERSATIONS));
  const proj = project();
  if (!proj) return;
  void (async () => {
    try {
      const { remove } = await import("@tauri-apps/plugin-fs");
      for (const conv of pruned) {
        dirtyConversations.delete(conv.id);
        await remove(`${proj.rootPath}/${conversationRelPath(conv.id)}`).catch(() => {});
      }
    } catch {
      /* best-effort */
    }
  })();
}

function appendTurn(conversationId: string, turn: ChatTurn): void {
  setConversations((prev) => {
    const conv = prev.find((c) => c.id === conversationId);
    if (!conv) return prev;
    const turns = [...conv.turns, turn];
    const title =
      conv.title === "New conversation" && turn.role === "user"
        ? deriveTitle(turn.content)
        : conv.title;
    const next: Conversation = { ...conv, title, turns, updatedAt: Date.now() };
    return [next, ...prev.filter((c) => c.id !== conversationId)];
  });
  scheduleSave(conversationId);
}

function dropLastAssistantTurn(conversationId: string): boolean {
  let dropped = false;
  setConversations((prev) =>
    prev.map((c) => {
      if (c.id !== conversationId) return c;
      const last = c.turns[c.turns.length - 1];
      if (!last || last.role !== "assistant") return c;
      dropped = true;
      return { ...c, turns: c.turns.slice(0, -1), updatedAt: Date.now() };
    }),
  );
  if (dropped) scheduleSave(conversationId);
  return dropped;
}

// ----- Persistence ---------------------------------------------------------

function scheduleSave(conversationId: string): void {
  const root = project()?.rootPath;
  if (!root) return; // No project open → in-memory only.
  dirtyConversations.set(conversationId, root);
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    void flushPendingAiChatSaves();
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Write every dirty conversation immediately. Payloads are captured
 * synchronously so callers may reset in-memory state right after this call
 * (project switch, window close). Writes go to the root captured when the
 * save was scheduled — never to whatever project is active by flush time.
 */
async function flushPendingAiChatSaves(): Promise<void> {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  if (dirtyConversations.size === 0) return;
  const jobs: Array<{ root: string; rel: string; data: string }> = [];
  for (const [id, root] of dirtyConversations) {
    const conv = conversations().find((c) => c.id === id);
    if (!conv || conv.turns.length === 0) continue;
    jobs.push({
      root,
      rel: conversationRelPath(id),
      data: serializeConversation(conv),
    });
  }
  dirtyConversations.clear();
  for (const job of jobs) {
    try {
      await ipc.writeProjectTextFile(job.root, job.rel, job.data);
    } catch (e) {
      recordError("ai-chat-save", `writing ${job.rel} failed`, e);
    }
  }
}

// ----- Streaming -----------------------------------------------------------

function currentProvider(): AiProvider | null {
  return activeProvider(integrationsSettings().ai.ollamaBaseUrl);
}

/**
 * The selected model for a provider: the persisted per-provider choice, else
 * the first model the provider reports (the repo's "no hardcoded defaults"
 * rule — defaults are whatever the live /models endpoint lists first).
 */
export async function resolveSelectedModel(prov: AiProvider): Promise<string> {
  const stored =
    integrationsSettings().ai.perProviderModel[prov.id as AiProviderId];
  if (stored) return stored;
  try {
    const models = await prov.models();
    return models[0]?.id ?? "";
  } catch {
    return "";
  }
}

function outboundMessages(conv: Conversation) {
  return conv.turns.map((t) => {
    const payloads = t.attachments?.filter((a) => a.base64.length > 0);
    return {
      role: t.role,
      content: t.content,
      ...(payloads && payloads.length > 0 ? { attachments: payloads } : {}),
    };
  });
}

async function runStream(conversationId: string): Promise<void> {
  const conv = conversations().find((c) => c.id === conversationId);
  if (!conv || conv.turns.length === 0) return;
  const prov = currentProvider();
  if (!prov) {
    setChatError(
      "No AI provider active — pick one in Settings → Integrations → AI.",
    );
    return;
  }
  const model = await resolveSelectedModel(prov);
  if (!model) {
    setChatError(
      "No model available — the provider may be unreachable. Check Settings → Integrations → AI.",
    );
    return;
  }
  const messages = outboundMessages(conv);
  const attachmentBytes = totalAttachmentBase64Bytes(messages);
  if (attachmentBytes > MAX_REQUEST_BASE64_BYTES) {
    setChatError(
      `Attached images total ${formatBytes(attachmentBytes)} — over the ${formatBytes(MAX_REQUEST_BASE64_BYTES)} request limit. Remove an image or start a new conversation.`,
    );
    return;
  }

  const controller = new AbortController();
  abortController = controller;
  setChatStreaming(true);
  setChatStreamingText("");
  setStreamingConversationId(conversationId);
  setChatError(null);

  let acc = "";
  let failed = false;
  try {
    for await (const chunk of prov.chat(messages, {
      model,
      signal: controller.signal,
    })) {
      if (chunk.delta) {
        acc += chunk.delta;
        setChatStreamingText(acc);
      }
      if (chunk.done) break;
    }
  } catch (err) {
    failed = true;
    setChatError(describeIpcError(err));
  } finally {
    const interrupted = controller.signal.aborted || failed;
    // Stop keeps the partial text as an assistant turn (rendered with a
    // "stopped" marker) instead of discarding it; an empty abort adds nothing.
    if (acc.length > 0 || !interrupted) {
      appendTurn(conversationId, {
        id: makeChatId(),
        role: "assistant",
        content: acc,
        createdAt: Date.now(),
        model,
        providerId: prov.id,
        ...(interrupted ? { interrupted: true } : {}),
      });
    }
    setChatStreaming(false);
    setChatStreamingText("");
    setStreamingConversationId(null);
    abortController = null;
  }
}

/**
 * Send a user turn (with the composer's attachments) into the active
 * conversation, creating one when none is active, then stream the reply.
 */
async function sendChatMessage(
  text: string,
  attachments: ChatAttachment[] = [],
): Promise<void> {
  if (chatStreaming()) return;
  const trimmed = text.trim();
  if (!trimmed) return;
  const conv = activeConversation() ?? newConversation();
  appendTurn(conv.id, {
    id: makeChatId(),
    role: "user",
    content: trimmed,
    createdAt: Date.now(),
    attachments: attachments.length > 0 ? attachments : undefined,
  });
  await runStream(conv.id);
}

function stopChatStream(): void {
  abortController?.abort();
}

/** Regenerate the last assistant turn with the current model/provider. */
async function regenerateLastTurn(): Promise<void> {
  if (chatStreaming()) return;
  const conv = activeConversation();
  if (!conv) return;
  if (!dropLastAssistantTurn(conv.id)) return;
  await runStream(conv.id);
}

/** Abort without touching turns — project close / window close path. */
function abortActiveAiStream(): void {
  abortController?.abort();
}

function resetChatState(): void {
  if (saveTimer) {
    clearTimeout(saveTimer);
    saveTimer = null;
  }
  dirtyConversations.clear();
  loadedRoot = null;
  loadSeq++;
  setConversations([]);
  setActiveConversationId(null);
  setChatError(null);
  setChatDraft("");
  setPendingAttachments([]);
  setChatStreamingText("");
  setStreamingConversationId(null);
}

// Project switch / close: abort any in-flight stream, flush pending saves to
// the roots they were scheduled against, then reset for the next project.
// Module-scope root — this store lives for the app's lifetime.
createRoot(() => {
  createEffect(
    on(
      () => project()?.rootPath ?? null,
      (root, prevRoot) => {
        if (prevRoot === undefined || root === prevRoot) return;
        abortActiveAiStream();
        // Flush captures payloads synchronously, so resetting right after is
        // safe — the writes still land in the previous project's sidecar.
        void flushPendingAiChatSaves();
        resetChatState();
      },
    ),
  );
});

function _resetAiChatForTests(): void {
  abortActiveAiStream();
  resetChatState();
  setChatStreaming(false);
}

export {
  activeConversation,
  activeConversationId,
  abortActiveAiStream,
  chatDraft,
  chatError,
  chatStreaming,
  chatStreamingText,
  conversations,
  deleteConversation,
  ensureConversationsLoaded,
  flushPendingAiChatSaves,
  newConversation,
  pendingAttachments,
  regenerateLastTurn,
  selectConversation,
  sendChatMessage,
  setChatDraft,
  setPendingAttachments,
  stopChatStream,
  streamingConversationId,
  _resetAiChatForTests,
};
