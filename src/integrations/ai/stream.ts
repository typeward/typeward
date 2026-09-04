/**
 * Frontend AsyncIterable adapter for the Rust AI streaming primitive.
 *
 * Usage:
 *   for await (const chunk of aiStream(req, abortController.signal)) {
 *     accumulator += chunk.delta;
 *   }
 *
 * The underlying transport is a Tauri event channel. We subscribe to
 * `ai-stream:<streamId>` on Rust side and surface each delta to the
 * AsyncIterable consumer. Aborting via the `AbortSignal` sends an
 * `ai_stream_abort` IPC so the Rust task drops its in-flight HTTP
 * request instead of running to completion in the background.
 */

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";

import type { HttpAuthRef } from "~/integrations/http";

export type AiStreamFormat =
  | "anthropic-sse"
  | "open-ai-sse"
  | "gemini-sse"
  | "ollama-ndjson";

export interface AiStreamRequest {
  method: "POST" | "GET";
  url: string;
  headers?: Record<string, string>;
  body: string;
  format: AiStreamFormat;
  authRef?: HttpAuthRef;
}

export interface AiStreamChunk {
  delta: string;
}

interface ChunkEvent {
  streamId: string;
  kind: "delta" | "done" | "error";
  delta?: string;
  error?: string;
}

/**
 * Open a streaming request and return an AsyncIterable of text deltas.
 * The stream completes when the upstream provider sends its terminal
 * marker; iteration stops naturally. On error, the iterator throws
 * with the provider's message.
 */
export async function* aiStream(
  req: AiStreamRequest,
  signal?: AbortSignal,
): AsyncIterable<AiStreamChunk> {
  const streamId = makeStreamId();
  const buffer: AiStreamChunk[] = [];
  let resolveNext: (() => void) | null = null;
  let done = false;
  let error: string | null = null;

  const pump = () => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r();
    }
  };

  const unlisten = await listen<ChunkEvent>(`ai-stream:${streamId}`, (event) => {
    const payload = event.payload;
    if (payload.kind === "delta" && payload.delta) {
      buffer.push({ delta: payload.delta });
      pump();
    } else if (payload.kind === "done") {
      done = true;
      pump();
    } else if (payload.kind === "error") {
      error = payload.error ?? "Unknown AI stream error";
      done = true;
      pump();
    }
  });

  const abortHandler = () => {
    void invoke("ai_stream_abort", { streamId }).catch(() => undefined);
    // The Rust side stays silent on abort (StreamEnd::Aborted emits no
    // terminal event by design), so the iterator must resolve itself —
    // without this local pump the consumer dead-awaits forever and the
    // chat pane stays stuck in its streaming state.
    done = true;
    pump();
  };
  if (signal?.aborted) {
    unlisten();
    return;
  }
  signal?.addEventListener("abort", abortHandler, { once: true });

  try {
    await invoke<void>("ai_stream_start", {
      req: {
        streamId,
        method: req.method,
        url: req.url,
        headers: req.headers ?? {},
        body: req.body,
        format: req.format,
        authRef: req.authRef,
      },
    });

    while (true) {
      if (buffer.length > 0) {
        const chunk = buffer.shift()!;
        yield chunk;
        continue;
      }
      if (done) {
        if (error) throw new Error(error);
        return;
      }
      await new Promise<void>((resolve) => {
        resolveNext = resolve;
      });
    }
  } finally {
    unlisten();
    signal?.removeEventListener("abort", abortHandler);
  }
}

function makeStreamId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}
