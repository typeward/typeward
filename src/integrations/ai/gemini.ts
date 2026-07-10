/**
 * Google Gemini provider.
 *
 * The API key lives in the OS keyring under `gemini` / `default`.
 * Requests pass an `authRef`; Rust reads the secret and attaches it as
 * `x-goog-api-key` so the key does not cross into frontend code.
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

const API_ROOT = "https://generativelanguage.googleapis.com/v1beta";
const KEYRING_SERVICE = "gemini";
const KEYRING_ACCOUNT = "default";
const authRef = {
  service: KEYRING_SERVICE,
  account: KEYRING_ACCOUNT,
  header: "x-goog-api-key",
  prefix: "",
};

interface GeminiModelList {
  models: Array<{
    name: string;
    displayName?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
}

export function createGeminiProvider(): AiProvider {
  return {
    id: "gemini",
    category: "ai",
    displayName: "Gemini (Google)",

    async status(): Promise<ProviderStatus> {
      try {
        const res = await httpRequest({
          method: "GET",
          url: `${API_ROOT}/models?pageSize=1`,
          authRef,
        });
        return res.status >= 200 && res.status < 300 ? "ready" : "unconfigured";
      } catch {
        return "unconfigured";
      }
    },

    async models(): Promise<ModelInfo[]> {
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/models?pageSize=100`,
        authRef,
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Gemini /models failed (status ${res.status})`);
      }
      const list = JSON.parse(res.body) as GeminiModelList;
      return list.models
        .filter((m) => m.supportedGenerationMethods?.includes("generateContent"))
        .map((m) => ({
          id: m.name.replace(/^models\//, ""),
          displayName: m.displayName ?? m.name,
          contextWindow: m.inputTokenLimit,
          supportsStreaming: true,
        }));
    },

    async *chat(messages, opts): AsyncIterable<ChatChunk> {
      yield* chatStream(messages, opts);
    },
  };
}

/**
 * Pure body builder, exported for wire-shape tests. Gemini's content shape:
 * roles are "user" / "model"; system content goes into `systemInstruction`;
 * image attachments become extra `inlineData` parts after the text part.
 * Attachment stubs (empty base64 after a reload) are skipped.
 */
export function buildGeminiChatBody(
  messages: ChatMessage[],
  opts: ChatOptions,
): string {
  const system = messages.find((m) => m.role === "system")?.content;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => {
      const images = (m.attachments ?? []).filter((a) => a.base64.length > 0);
      return {
        role: m.role === "assistant" ? "model" : "user",
        parts: [
          { text: m.content },
          ...images.map((a) => ({
            inlineData: { mimeType: a.mime, data: a.base64 },
          })),
        ],
      };
    });

  return JSON.stringify({
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      temperature: opts.temperature,
      maxOutputTokens: opts.maxTokens,
    },
  });
}

async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
): AsyncIterable<ChatChunk> {
  const body = buildGeminiChatBody(messages, opts);

  const url = `${API_ROOT}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse`;

  const stream = aiStream(
    {
      method: "POST",
      url,
      headers: { "Content-Type": "application/json" },
      body,
      format: "gemini-sse",
      authRef,
    },
    opts.signal,
  );

  for await (const chunk of stream as AsyncIterable<AiStreamChunk>) {
    yield { delta: chunk.delta };
  }
  yield { delta: "", done: true };
}
