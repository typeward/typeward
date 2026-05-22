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
      const body = JSON.stringify({
        model: opts.model,
        messages,
        options: {
          temperature: opts.temperature,
          num_predict: opts.maxTokens,
        },
        stream: true,
      });

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
