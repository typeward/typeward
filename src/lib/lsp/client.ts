import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

/**
 * Phase 1 LSP transport client. Talks to the Rust LSP manager over Tauri
 * event channels — incoming server messages stream as events, outgoing
 * requests go via `invoke`. JSON-RPC framing (Content-Length headers) is
 * handled in Rust; payloads here are JSON-RPC objects on the wire.
 *
 * The raw {@link LanguageServerClient} returned by {@link startLsp} is a
 * thin send/receive surface — for actual LSP semantics use {@link wrap}
 * which adds request/response correlation and notification subscriptions.
 */

// -------- Raw transport -----------------------------------------------------

export interface LanguageServerClient {
  serverId: string;
  /** Send a raw JSON-RPC payload (already a JSON string). */
  sendMessage(message: string): Promise<void>;
  /** Subscribe to inbound JSON-RPC payloads. Returns an unsubscribe fn. */
  onMessage(handler: (message: string) => void): UnlistenFn;
  /** Tear down: stops the server process and detaches all listeners. */
  stop(): Promise<void>;
}

interface StartArgs {
  languageId: "latex" | "typst";
  projectRoot: string;
}

interface StartResult {
  serverId: string;
}

export async function startLsp(args: StartArgs): Promise<LanguageServerClient> {
  const { serverId } = await invoke<StartResult>("start_lsp", { args });

  const eventName = `lsp:${serverId}:message`;
  const handlers = new Set<(message: string) => void>();
  const unlistenPromise = listen<string>(eventName, (e) => {
    for (const h of handlers) h(e.payload);
  });

  return {
    serverId,
    async sendMessage(message: string) {
      await invoke("send_lsp_message", { serverId, message });
    },
    onMessage(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async stop() {
      handlers.clear();
      const unlisten = await unlistenPromise;
      unlisten();
      await invoke("stop_lsp", { serverId });
    },
  };
}

function serverRequestResult(method: string, params: unknown): unknown {
  if (method === "workspace/configuration") {
    const items = (params as { items?: unknown[] } | null)?.items;
    return Array.isArray(items) ? items.map(() => null) : [];
  }
  return null;
}

export class LspUnavailableError extends Error {
  constructor(public readonly languageId: string, public readonly binary: string) {
    super(`Language server for ${languageId} (${binary}) is not on PATH`);
  }
}

// -------- JSON-RPC wrapper --------------------------------------------------

export interface JsonRpcClient {
  /** Send a request, await its matching response. */
  request<T = unknown>(method: string, params?: unknown, timeoutMs?: number): Promise<T>;
  /** Fire-and-forget notification (no response expected). */
  notify(method: string, params?: unknown): void;
  /** Subscribe to server-pushed notifications for a given method. */
  onNotification(method: string, handler: (params: unknown) => void): () => void;
  /** Tear down — stops the underlying transport too. */
  stop(): Promise<void>;
}

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  timeout: ReturnType<typeof setTimeout>;
}

/**
 * Wrap a raw transport in a JSON-RPC client. Correlates requests with
 * responses by id, dispatches notifications to subscribers.
 */
export function wrap(transport: LanguageServerClient): JsonRpcClient {
  let nextId = 1;
  const pending = new Map<number | string, PendingRequest>();
  const notificationHandlers = new Map<string, Set<(params: unknown) => void>>();

  transport.onMessage((raw) => {
    let msg: { id?: number | string; method?: string; result?: unknown; error?: unknown; params?: unknown };
    try {
      msg = JSON.parse(raw);
    } catch {
      return;
    }
    // Response to one of our requests: has `id` and either `result` or `error`.
    if (msg.id != null && (msg.method == null)) {
      const entry = pending.get(msg.id);
      if (entry) {
        clearTimeout(entry.timeout);
        pending.delete(msg.id);
        if (msg.error) entry.reject(msg.error);
        else entry.resolve(msg.result);
      }
      return;
    }
    if (msg.method && msg.id != null) {
      const result = serverRequestResult(msg.method, msg.params);
      void transport
        .sendMessage(JSON.stringify({ jsonrpc: "2.0", id: msg.id, result }))
        .catch(() => {});
      return;
    }
    // Server notification: has `method` and `params`, no `id`.
    if (msg.method && msg.id == null) {
      const handlers = notificationHandlers.get(msg.method);
      if (handlers) {
        for (const h of handlers) h(msg.params);
      }
      return;
    }
    // Server-initiated request (rare; ignore for now — return null response).
  });

  return {
    request<T>(method: string, params?: unknown, timeoutMs = 8000): Promise<T> {
      const id = nextId++;
      const payload = JSON.stringify({ jsonrpc: "2.0", id, method, params });
      return new Promise<T>((resolve, reject) => {
        const timeout = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`LSP request '${method}' timed out`));
        }, timeoutMs);
        pending.set(id, {
          resolve: (v) => resolve(v as T),
          reject,
          timeout,
        });
        transport.sendMessage(payload).catch((e) => {
          clearTimeout(timeout);
          pending.delete(id);
          reject(e);
        });
      });
    },
    notify(method: string, params?: unknown) {
      const payload = JSON.stringify({ jsonrpc: "2.0", method, params });
      // Fire and forget — errors swallowed.
      void transport.sendMessage(payload).catch(() => {});
    },
    onNotification(method, handler) {
      let set = notificationHandlers.get(method);
      if (!set) {
        set = new Set();
        notificationHandlers.set(method, set);
      }
      set.add(handler);
      return () => {
        set?.delete(handler);
      };
    },
    async stop() {
      // Reject pending requests so callers don't hang.
      for (const entry of pending.values()) {
        clearTimeout(entry.timeout);
        entry.reject(new Error("LSP stopped"));
      }
      pending.clear();
      notificationHandlers.clear();
      await transport.stop();
    },
  };
}
