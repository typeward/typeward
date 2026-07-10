import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChatChunk, ChatMessage, ChatOptions } from "~/integrations/types";

const spies = vi.hoisted(() => ({
  writeProjectTextFile: vi.fn(async () => {}),
  readProjectTextFile: vi.fn(async (_root: string, _rel: string) => ""),
  readDir: vi.fn(async () => [] as Array<{ name: string; isFile: boolean }>),
  remove: vi.fn(async () => {}),
  chatImpl: null as
    | ((messages: ChatMessage[], opts: ChatOptions) => AsyncIterable<ChatChunk>)
    | null,
}));

vi.mock("~/ipc", async () => {
  const { ipcMock } = await import("~/test/ipc-mock");
  return ipcMock({
    loadSettings: vi.fn(async () => {
      throw new Error("no tauri in tests");
    }),
    saveSettings: vi.fn(async () => {}),
    readProjectTextFile: spies.readProjectTextFile,
    writeProjectTextFile: spies.writeProjectTextFile,
  });
});

vi.mock("@tauri-apps/plugin-fs", () => ({
  readDir: spies.readDir,
  remove: spies.remove,
}));

vi.mock("~/integrations/ai/registry", () => ({
  activeProvider: () => ({
    id: "anthropic",
    category: "ai",
    displayName: "Fake",
    status: async () => "ready" as const,
    models: async () => [
      { id: "model-1", displayName: "Model 1", supportsStreaming: true },
    ],
    chat: (messages: ChatMessage[], opts: ChatOptions) =>
      spies.chatImpl!(messages, opts),
  }),
  activeProviderId: () => "anthropic",
  hasAnyAiEntitlement: () => true,
}));

import { setProject } from "~/stores/editor-store";
import {
  _resetAiChatForTests,
  activeConversation,
  chatStreaming,
  chatStreamingText,
  conversations,
  ensureConversationsLoaded,
  flushPendingAiChatSaves,
  regenerateLastTurn,
  sendChatMessage,
  stopChatStream,
} from "./ai-chat-store";
import { serializeConversation } from "./ai-chat-jsonl";

const PROJECT = {
  rootPath: "C:/Users/x/Documents/Typeward/paper",
  rootFile: "main.tex",
  format: "latex" as const,
  name: "paper",
};

async function until(cond: () => boolean, timeoutMs = 1000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition timed out");
    await new Promise((r) => setTimeout(r, 5));
  }
}

beforeEach(() => {
  _resetAiChatForTests();
  setProject({ ...PROJECT });
  spies.writeProjectTextFile.mockClear();
  spies.readProjectTextFile.mockClear();
  spies.readDir.mockClear().mockResolvedValue([]);
  spies.remove.mockClear();
  spies.chatImpl = null;
});

describe("sendChatMessage", () => {
  it("streams into an assistant turn and persists JSONL", async () => {
    spies.chatImpl = async function* () {
      yield { delta: "Hi " };
      yield { delta: "there" };
      yield { delta: "", done: true };
    };

    await sendChatMessage("hello assistant");

    const conv = activeConversation()!;
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[0]).toMatchObject({ role: "user", content: "hello assistant" });
    expect(conv.turns[1]).toMatchObject({
      role: "assistant",
      content: "Hi there",
      model: "model-1",
      providerId: "anthropic",
    });
    expect(conv.turns[1].interrupted).toBeUndefined();
    expect(conv.title).toBe("hello assistant");

    await flushPendingAiChatSaves();
    expect(spies.writeProjectTextFile).toHaveBeenCalledWith(
      PROJECT.rootPath,
      `.typeward/ai/conversations/${conv.id}.jsonl`,
      expect.stringContaining('"role":"user"'),
    );
  });

  it("keeps the partial text as an interrupted turn on Stop", async () => {
    spies.chatImpl = async function* (_messages, opts) {
      yield { delta: "partial " };
      await new Promise<void>((resolve) => {
        opts.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    };

    const sending = sendChatMessage("stop me");
    // Wait for the first delta, not just the streaming flag — the flag now
    // flips before the model resolves, and this test stops mid-stream.
    await until(() => chatStreamingText().includes("partial"));
    stopChatStream();
    await sending;

    const conv = activeConversation()!;
    expect(conv.turns[1]).toMatchObject({
      role: "assistant",
      content: "partial ",
      interrupted: true,
    });
    expect(chatStreaming()).toBe(false);
  });

  it("ignores a second Send while the first is still resolving its model", async () => {
    spies.chatImpl = async function* () {
      yield { delta: "one", done: true };
    };

    // The first send is suspended on its model fetch here; a duplicate must
    // not append a second user turn or start a concurrent stream.
    const first = sendChatMessage("first");
    const second = sendChatMessage("duplicate");
    await Promise.all([first, second]);

    const conv = activeConversation()!;
    expect(conv.turns.map((t) => t.role)).toEqual(["user", "assistant"]);
    expect(conv.turns[0].content).toBe("first");
  });

  it("appends no assistant turn when a stream completes with zero output", async () => {
    spies.chatImpl = async function* () {
      yield { delta: "", done: true };
    };

    await sendChatMessage("silent");

    const conv = activeConversation()!;
    expect(conv.turns).toHaveLength(1);
    expect(conv.turns[0].role).toBe("user");
    expect(chatStreaming()).toBe(false);
  });

  it("sends the prior turns on the wire, without attachment stubs", async () => {
    let seen: ChatMessage[] = [];
    spies.chatImpl = async function* (messages) {
      seen = messages;
      yield { delta: "ok", done: true };
    };

    await sendChatMessage("first", [
      { kind: "image", mime: "image/png", base64: "QUJD", bytes: 3 },
    ]);
    expect(seen).toHaveLength(1);
    expect(seen[0].attachments).toHaveLength(1);

    await sendChatMessage("second");
    expect(seen).toHaveLength(3);
    expect(seen.map((m) => m.role)).toEqual(["user", "assistant", "user"]);
  });
});

describe("regenerateLastTurn", () => {
  it("drops the last assistant turn and re-streams with the prior turns", async () => {
    spies.chatImpl = async function* () {
      yield { delta: "first answer", done: true };
    };
    await sendChatMessage("question");

    let seen: ChatMessage[] = [];
    spies.chatImpl = async function* (messages) {
      seen = messages;
      yield { delta: "better answer", done: true };
    };
    await regenerateLastTurn();

    const conv = activeConversation()!;
    expect(conv.turns).toHaveLength(2);
    expect(conv.turns[1].content).toBe("better answer");
    expect(seen.map((m) => m.role)).toEqual(["user"]);
  });
});

describe("ensureConversationsLoaded", () => {
  it("loads sidecar files, skipping unparseable ones", async () => {
    const good = serializeConversation({
      id: "conv-a",
      title: "Loaded",
      createdAt: 1,
      updatedAt: 2,
      turns: [{ id: "t", role: "user", content: "hi", createdAt: 1 }],
    });
    spies.readDir.mockResolvedValue([
      { name: "conv-a.jsonl", isFile: true },
      { name: "broken.jsonl", isFile: true },
      { name: "notes.txt", isFile: true },
    ]);
    spies.readProjectTextFile.mockImplementation(async (_root: string, rel: string) =>
      rel.endsWith("conv-a.jsonl") ? good : "corrupt",
    );

    await ensureConversationsLoaded();

    expect(conversations()).toHaveLength(1);
    expect(conversations()[0]).toMatchObject({ id: "conv-a", title: "Loaded" });
    // Only .jsonl files are read at all.
    expect(spies.readProjectTextFile).toHaveBeenCalledTimes(2);
  });
});
