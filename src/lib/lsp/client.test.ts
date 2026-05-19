import { describe, expect, it, vi } from "vitest";
import { wrap, type LanguageServerClient } from "./client";

const makeTransport = () => {
  let handler: ((message: string) => void) | null = null;
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
    stop: vi.fn(async () => undefined),
  };
  return {
    sendMessage,
    transport,
    emit(message: unknown) {
      handler?.(JSON.stringify(message));
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
});
