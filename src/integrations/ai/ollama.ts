/**
 * Ollama (local) provider.
 *
 * Runs against a local `ollama serve` daemon — default base URL
 * `http://localhost:11434`, configurable via
 * `IntegrationsSettings.ai.ollamaBaseUrl`. No auth, no keyring slot:
 * if Ollama is reachable, the user is "signed in."
 *
 * Streams NDJSON; the Rust parser handles the line splitting.
 */

import { httpRequest } from "~/integrations/http";
import { aiStream, type AiStreamChunk } from "~/integrations/ai/stream";
import type {
  AiProvider,
  ChatChunk,
  ChatMessage,
  ChatOptions,
  ModelInfo,
  ProviderStatus,
} from "~/integrations/types";

const DEFAULT_BASE = "http://localhost:11434";

interface OllamaTagList {
  models: Array<{
    name: string;
    size?: number;
    modified_at?: string;
    details?: { parameter_size?: string; family?: string };
  }>;
}

export function createOllamaProvider(baseUrl?: string): AiProvider {
  const base = (baseUrl?.trim() || DEFAULT_BASE).replace(/\/+$/, "");

  return {
    id: "ollama",
    category: "ai",
    displayName: "Ollama (local)",

    async status(): Promise<ProviderStatus> {
      try {
        const res = await httpRequest({ method: "GET", url: `${base}/api/tags` });
        return res.status >= 200 && res.status < 300 ? "ready" : "error";
      } catch {
        return "error";
      }
    },

    async models(): Promise<ModelInfo[]> {
      const res = await httpRequest({ method: "GET", url: `${base}/api/tags` });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Ollama /api/tags failed (status ${res.status})`);
      }
      const list = JSON.parse(res.body) as OllamaTagList;
      return list.models.map((m) => ({
        id: m.name,
        displayName: m.details?.parameter_size
          ? `${m.name} (${m.details.parameter_size})`
          : m.name,
        supportsStreaming: true,
      }));
    },

    async *chat(messages, opts): AsyncIterable<ChatChunk> {
      const body = buildOllamaChatBody(messages, opts);

      const stream = aiStream(
        {
          method: "POST",
          url: `${base}/api/chat`,
          headers: { "Content-Type": "application/json" },
          body,
          format: "ollama-ndjson",
        },
        opts.signal,
      );

      for await (const chunk of stream as AsyncIterable<AiStreamChunk>) {
        yield { delta: chunk.delta };
      }
      yield { delta: "", done: true };
    },
  };
}

/**
 * Pure body builder, exported for wire-shape tests. Ollama takes images as a
 * message-level `images` array of bare base64 strings; the internal
 * `attachments` field never reaches the wire. Attachment stubs (empty base64
 * after a reload) are skipped.
 */
export function buildOllamaChatBody(
  messages: ChatMessage[],
  opts: ChatOptions,
): string {
  const wireMessages = messages.map((m) => {
    const images = (m.attachments ?? []).filter((a) => a.base64.length > 0);
    return images.length === 0
      ? { role: m.role, content: m.content }
      : { role: m.role, content: m.content, images: images.map((a) => a.base64) };
  });

  return JSON.stringify({
    model: opts.model,
    messages: wireMessages,
    options: {
      temperature: opts.temperature,
      num_predict: opts.maxTokens,
    },
    stream: true,
  });
}
