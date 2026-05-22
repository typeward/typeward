/**
 * Google Gemini provider.
 *
 * Gemini's API auth quirk: the key goes in the query string (`?key=`)
 * rather than a header. Storing it in the keyring under `gemini` /
 * `default` is still the right move — we fetch it in Rust via a
 * keyring lookup just before issuing the request, by reading it from
 * the header (which is dropped) and re-injecting it into the URL.
 *
 * Phase 4 takes the simpler path: read the key on the frontend via
 * `getCredential` and append it to the URL ourselves. Briefly in
 * memory, never on disk outside the keyring — same compromise as
 * Mendeley / Dropbox during their initial dance.
 */

import { getCredential } from "~/integrations/auth/credentials";
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

interface GeminiModelList {
  models: Array<{
    name: string;
    displayName?: string;
    inputTokenLimit?: number;
    supportedGenerationMethods?: string[];
  }>;
}

async function apiKey(): Promise<string> {
  const value = await getCredential({
    service: KEYRING_SERVICE,
    account: KEYRING_ACCOUNT,
  });
  if (!value) throw new Error("Gemini API key not configured");
  return value;
}

export function createGeminiProvider(): AiProvider {
  return {
    id: "gemini",
    category: "ai",
    displayName: "Gemini (Google)",

    async status(): Promise<ProviderStatus> {
      try {
        const key = await apiKey();
        const res = await httpRequest({
          method: "GET",
          url: `${API_ROOT}/models?key=${encodeURIComponent(key)}&pageSize=1`,
        });
        return res.status >= 200 && res.status < 300 ? "ready" : "unconfigured";
      } catch {
        return "unconfigured";
      }
    },

    async models(): Promise<ModelInfo[]> {
      const key = await apiKey();
      const res = await httpRequest({
        method: "GET",
        url: `${API_ROOT}/models?key=${encodeURIComponent(key)}&pageSize=100`,
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

async function* chatStream(
  messages: ChatMessage[],
  opts: ChatOptions,
): AsyncIterable<ChatChunk> {
  const key = await apiKey();

  // Gemini's content shape: roles are "user" / "model"; system content
  // goes into `systemInstruction`. Map our generic messages onto that.
  const system = messages.find((m) => m.role === "system")?.content;
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.content }],
    }));

  const body = JSON.stringify({
    systemInstruction: system ? { parts: [{ text: system }] } : undefined,
    contents,
    generationConfig: {
      temperature: opts.temperature,
      maxOutputTokens: opts.maxTokens,
    },
  });

  const url = `${API_ROOT}/models/${encodeURIComponent(opts.model)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;

  const stream = aiStream(
    {
      method: "POST",
      url,
      headers: { "Content-Type": "application/json" },
      body,
      format: "gemini-sse",
    },
    opts.signal,
  );

  for await (const chunk of stream as AsyncIterable<AiStreamChunk>) {
    yield { delta: chunk.delta };
  }
  yield { delta: "", done: true };
}
