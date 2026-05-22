/**
 * Anthropic Claude provider.
 *
 * Uses the Messages API with streaming via SSE. The API key lives in
 * the OS keyring under service `anthropic` / account `default`; the
 * Rust streaming primitive reads it via `authRef` before opening the
 * stream so the bearer never crosses the IPC boundary.
 *
 * Models are pulled from /v1/models at provider boot — same Anthropic
 * dashboard you'd see in their docs.
 */

import { httpRequest } from "~/integrations/http";
import { aiStream, type AiStreamChunk } from "~/integrations/ai/stream";
import type {
  AiProvider,
  ChatMessage,
  ChatOptions,
  ChatChunk,
  ModelInfo,
  ProviderStatus,
} from "~/integrations/types";

const API_ROOT = "https://api.anthropic.com/v1";
const API_VERSION = "2023-06-01";
const KEYRING_SERVICE = "anthropic";
const KEYRING_ACCOUNT = "default";

interface AnthropicModelList {
  data: Array<{ id: string; display_name?: string; context_window?: number }>;
}

export function createAnthropicProvider(): AiProvider {
  const auth = {
    service: KEYRING_SERVICE,
    account: KEYRING_ACCOUNT,
    header: "x-api-key",
    prefix: "",
  };

  return {
    id: "anthropic",
    category: "ai",
    displayName: "Claude (Anthropic)",

    async status(): Promise<ProviderStatus> {
      const probe = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/models?limit=1`,
        headers: { "anthropic-version": API_VERSION },
        authRef: auth,
      });
      return probe.status >= 200 && probe.status < 300 ? "ready" : "unconfigured";
    },

    async models(): Promise<ModelInfo[]> {
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/models`,
        headers: { "anthropic-version": API_VERSION },
        authRef: auth,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Anthropic /models failed (status ${res.status})`);
      }
      const list = JSON.parse(res.body) as AnthropicModelList;
      return list.data.map((m) => ({
        id: m.id,
        displayName: m.display_name ?? m.id,
        contextWindow: m.context_window,
        supportsStreaming: true,
      }));
    },

    chat(messages, opts) {
      return chatStream(messages, opts, auth);
    },
  };
}

async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  authRef: { service: string; account: string; header: string; prefix: string },
): AsyncIterable<ChatChunk> {
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role, content: m.content }));

  const body = JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature,
    system,
    messages: turns,
    stream: true,
  });

  const stream = aiStream(
    {
      method: "POST",
      url: `${API_ROOT}/messages`,
      headers: {
        "anthropic-version": API_VERSION,
        "Content-Type": "application/json",
      },
      body,
      format: "anthropic-sse",
      authRef,
    },
    opts.signal,
  );

  yield* mapChunks(stream);
}

async function* mapChunks(
  stream: AsyncIterable<AiStreamChunk>,
): AsyncIterable<ChatChunk> {
  for await (const chunk of stream) {
    yield { delta: chunk.delta };
  }
  yield { delta: "", done: true };
}
