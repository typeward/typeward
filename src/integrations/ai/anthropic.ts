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

/**
 * Pure body builder, exported for wire-shape tests. Messages with image
 * attachments become content-block arrays (images first, then text, per
 * Anthropic's guidance); text-only messages keep the plain-string shape.
 * Attachment stubs (persisted turns whose payload didn't survive a reload)
 * carry an empty base64 and are skipped.
 */
export function buildAnthropicChatBody(
  messages: ChatMessage[],
  opts: ChatOptions,
): string {
  const system = messages.find((m) => m.role === "system")?.content;
  const turns = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const images = (m.attachments ?? []).filter((a) => a.base64.length > 0);
      if (images.length === 0) return { role: m.role, content: m.content };
      return {
        role: m.role,
        content: [
          ...images.map((a) => ({
            type: "image" as const,
            source: { type: "base64" as const, media_type: a.mime, data: a.base64 },
          })),
          { type: "text" as const, text: m.content },
        ],
      };
    });

  return JSON.stringify({
    model: opts.model,
    max_tokens: opts.maxTokens ?? 4096,
    temperature: opts.temperature,
    system,
    messages: turns,
    stream: true,
  });
}

async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  authRef: { service: string; account: string; header: string; prefix: string },
): AsyncIterable<ChatChunk> {
  const body = buildAnthropicChatBody(messages, opts);

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
