/**
 * OpenAI Chat Completions provider.
 *
 * API key in keyring `openai` / `default`. Bearer auth via the
 * standard `Authorization` header. Streams use the chat completions
 * SSE format; `data: [DONE]` terminates the stream and is filtered
 * by the Rust parser.
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

const API_ROOT = "https://api.openai.com/v1";
const KEYRING_SERVICE = "openai";
const KEYRING_ACCOUNT = "default";

interface OpenAIModelList {
  data: Array<{ id: string; owned_by?: string }>;
}

export function createOpenAIProvider(): AiProvider {
  const auth = {
    service: KEYRING_SERVICE,
    account: KEYRING_ACCOUNT,
    header: "Authorization",
    prefix: "Bearer ",
  };

  return {
    id: "openai",
    category: "ai",
    displayName: "ChatGPT (OpenAI)",

    async status(): Promise<ProviderStatus> {
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/models?limit=1`,
        authRef: auth,
      });
      return res.status >= 200 && res.status < 300 ? "ready" : "unconfigured";
    },

    async models(): Promise<ModelInfo[]> {
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/models`,
        authRef: auth,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`OpenAI /models failed (status ${res.status})`);
      }
      const list = JSON.parse(res.body) as OpenAIModelList;
      return list.data
        .filter((m) => /^(gpt-|o[0-9])/.test(m.id))
        .map((m) => ({
          id: m.id,
          displayName: m.id,
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
 * attachments use the content-array shape with `image_url` data URLs;
 * text-only messages keep the plain-string content (and never leak the
 * internal `attachments` field onto the wire). Attachment stubs (empty
 * base64 after a reload) are skipped.
 */
export function buildOpenAIChatBody(
  messages: ChatMessage[],
  opts: ChatOptions,
): string {
  const wireMessages = messages.map((m) => {
    const images = (m.attachments ?? []).filter((a) => a.base64.length > 0);
    if (images.length === 0) return { role: m.role, content: m.content };
    return {
      role: m.role,
      content: [
        { type: "text" as const, text: m.content },
        ...images.map((a) => ({
          type: "image_url" as const,
          image_url: { url: `data:${a.mime};base64,${a.base64}` },
        })),
      ],
    };
  });

  return JSON.stringify({
    model: opts.model,
    messages: wireMessages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: true,
  });
}

async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  authRef: { service: string; account: string; header: string; prefix: string },
): AsyncIterable<ChatChunk> {
  const body = buildOpenAIChatBody(messages, opts);

  const stream = aiStream(
    {
      method: "POST",
      url: `${API_ROOT}/chat/completions`,
      headers: { "Content-Type": "application/json" },
      body,
      format: "open-ai-sse",
      authRef,
    },
    opts.signal,
  );

  for await (const chunk of stream as AsyncIterable<AiStreamChunk>) {
    yield { delta: chunk.delta };
  }
  yield { delta: "", done: true };
}
