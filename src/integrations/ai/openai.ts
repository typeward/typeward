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

async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
  authRef: { service: string; account: string; header: string; prefix: string },
): AsyncIterable<ChatChunk> {
  const body = JSON.stringify({
    model: opts.model,
    messages,
    temperature: opts.temperature,
    max_tokens: opts.maxTokens,
    stream: true,
  });

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
