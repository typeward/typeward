import { describe, expect, it, vi } from "vitest";
import { wrap, type LanguageServerClient } from "./client";

const makeTransport = () => {
  let handler: ((message: string) => void) | null = null;
  let closeHandler: (() => void) | null = null;
  const sendMessage = vi.fn(async (_message: string) => undefined);
  const transport: LanguageServerClient = {
    serverId: "test",
    sendMessage,
    onMessage(next) {
      handler = next;
      return () => {
        handler = null;
      };
    },
    onClose(next) {
      closeHandler = next;
      return () => {
        closeHandler = null;
      };
    },
    stop: vi.fn(async () => undefined),
  };
  return {
    sendMessage,
    transport,
    emit(message: unknown) {
      handler?.(JSON.stringify(message));
    },
    close() {
      closeHandler?.();
    },
  };
};

describe("wrap", () => {
  it("responds to server-initiated JSON-RPC requests", async () => {
    const { emit, sendMessage, transport } = makeTransport();
    wrap(transport);

    emit({
      jsonrpc: "2.0",
      id: 7,
      method: "client/registerCapability",
      params: { registrations: [] },
    });
    await Promise.resolve();

    expect(sendMessage).toHaveBeenCalledTimes(1);
    const response = sendMessage.mock.calls[0]?.[0];
    expect(response).toBeDefined();
    expect(JSON.parse(response as string)).toEqual({
      jsonrpc: "2.0",
      id: 7,
      result: null,
    });
  });

  it("returns one null config item per workspace/configuration request item", async () => {
    const { emit, sendMessage, transport } = makeTransport();
    wrap(transport);

    emit({
      jsonrpc: "2.0",
      id: "cfg",
      method: "workspace/configuration",
      params: { items: [{ section: "texlab" }, { section: "tinymist" }] },
    });
    await Promise.resolve();

    const response = sendMessage.mock.calls[0]?.[0];
    expect(response).toBeDefined();
    expect(JSON.parse(response as string)).toEqual({
      jsonrpc: "2.0",
      id: "cfg",
      result: [null, null],
    });
  });

  it("rejects in-flight requests when the server closes", async () => {
    const { close, transport } = makeTransport();
    const client = wrap(transport);

    const inflight = client.request("textDocument/completion", {}, 8000);
    close();

    await expect(inflight).rejects.toThrow(/server exited/i);
    // Subsequent requests fail fast instead of waiting out the timeout.
    await expect(client.request("textDocument/hover", {})).rejects.toThrow(
      /not running/i,
    );
  });
});
