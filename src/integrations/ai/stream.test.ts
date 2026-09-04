import { beforeEach, describe, expect, it, vi } from "vitest";

// Regression coverage for the abort dead-await: `ai_stream_abort` emits no
// terminal event (Rust's StreamEnd::Aborted is silent by design), so the
// iterator must resolve itself when the AbortSignal fires.

const invokeMock = vi.hoisted(() => vi.fn());
const listenMock = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));
vi.mock("@tauri-apps/api/event", () => ({ listen: listenMock }));

import { aiStream, type AiStreamRequest } from "./stream";

const REQ: AiStreamRequest = {
  method: "POST",
  url: "https://api.anthropic.com/v1/messages",
  body: "{}",
  format: "anthropic-sse",
};

describe("aiStream abort semantics", () => {
  let emit: ((payload: Record<string, unknown>) => void) | null;
  let unlisten: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    emit = null;
    unlisten = vi.fn();
    invokeMock.mockReset().mockResolvedValue(undefined);
    listenMock.mockReset().mockImplementation((_event: string, handler: (e: { payload: unknown }) => void) => {
      emit = (payload) => handler({ payload });
      return Promise.resolve(unlisten);
    });
  });

  it("resolves the iterator locally when the signal aborts mid-stream", async () => {
    const controller = new AbortController();
    const deltas: string[] = [];

    const consume = (async () => {
      for await (const chunk of aiStream(REQ, controller.signal)) {
        deltas.push(chunk.delta);
        if (deltas.length === 1) controller.abort();
      }
    })();

    // Let the listen + start invokes settle, then feed one delta; the consumer
    // aborts after receiving it and no terminal event ever arrives.
    await Promise.resolve();
    await Promise.resolve();
    emit!({ streamId: "x", kind: "delta", delta: "partial " });

    await consume;

    expect(deltas).toEqual(["partial "]);
    expect(invokeMock).toHaveBeenCalledWith("ai_stream_abort", {
      streamId: expect.any(String),
    });
    expect(unlisten).toHaveBeenCalled();
  });

  it("yields nothing when the signal is already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const deltas: string[] = [];
    for await (const chunk of aiStream(REQ, controller.signal)) {
      deltas.push(chunk.delta);
    }
    expect(deltas).toEqual([]);
    expect(invokeMock).not.toHaveBeenCalledWith(
      "ai_stream_start",
      expect.anything(),
    );
  });

  it("completes on the terminal done event and stops listening", async () => {
    const deltas: string[] = [];
    const consume = (async () => {
      for await (const chunk of aiStream(REQ)) deltas.push(chunk.delta);
    })();

    await Promise.resolve();
    await Promise.resolve();
    emit!({ streamId: "x", kind: "delta", delta: "a" });
    emit!({ streamId: "x", kind: "delta", delta: "b" });
    emit!({ streamId: "x", kind: "done" });

    await consume;
    expect(deltas).toEqual(["a", "b"]);
    expect(unlisten).toHaveBeenCalled();
  });

  it("throws the provider error from an error event", async () => {
    const consume = (async () => {
      const seen: string[] = [];
      for await (const chunk of aiStream(REQ)) seen.push(chunk.delta);
      return seen;
    })();

    await Promise.resolve();
    await Promise.resolve();
    emit!({ streamId: "x", kind: "error", error: "429 rate limited" });

    await expect(consume).rejects.toThrow("429 rate limited");
  });
});
