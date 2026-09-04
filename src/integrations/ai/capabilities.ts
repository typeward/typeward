/**
 * Image-input capability matrix. The repo deliberately hardcodes zero model
 * IDs (models come from the live /models endpoints), so capability is a data
 * table keyed by provider + id-pattern over those live-fetched ids —
 * **default closed** (unmatched → no attachments). A wrongly-closed row costs
 * a hidden attach button; a wrongly-open one costs a provider 400 surfaced
 * verbatim — both cheap, both fixed by editing this table.
 *
 * Ollama is live, not a table: recent daemons report a `capabilities` array
 * from POST /api/show; `"vision"` present → true. Probed lazily per selected
 * model and cached; older daemons without the field stay closed.
 */

import { httpRequest } from "~/integrations/http";
import type { AiProviderId } from "./registry";

interface ImageCapabilityRow {
  allow: RegExp[];
  /** Text-only exceptions inside an allowed family (checked first). */
  deny?: RegExp[];
}

const IMAGE_CAPABLE: Partial<Record<AiProviderId, ImageCapabilityRow>> = {
  // Every current /v1/models entry is a Claude-3-or-later generation with
  // image input; the deny slot stays for text-only exceptions (3.5 Haiku
  // shipped text-only before gaining vision — exactly why this is config).
  anthropic: { allow: [/^claude-/], deny: [] },
  openai: {
    allow: [/^gpt-4o/, /^gpt-4\.1/, /^gpt-5/, /^o3$/, /^o4-mini/],
  },
  // Current generateContent Gemini models are natively multimodal; non-gemini
  // ids on that endpoint (gemma-* etc.) stay closed.
  gemini: { allow: [/^gemini-/] },
};

/**
 * Table lookup for the cloud providers. Returns `null` for Ollama — its
 * capability is a live per-model probe (`ollamaModelSupportsImages`), not a
 * pattern over the id.
 */
export function imageCapabilityFromTable(
  providerId: AiProviderId,
  modelId: string,
): boolean | null {
  if (providerId === "ollama") return null;
  const row = IMAGE_CAPABLE[providerId];
  if (!row) return false;
  if (row.deny?.some((re) => re.test(modelId))) return false;
  return row.allow.some((re) => re.test(modelId));
}

interface OllamaShowResponse {
  capabilities?: string[];
}

const ollamaVisionCache = new Map<string, boolean>();

/** Test-only: reset the per-model probe cache. */
export function _resetOllamaVisionCacheForTests(): void {
  ollamaVisionCache.clear();
}

/**
 * Live vision probe for a local Ollama model. Loopback http rides the same
 * allowlisted `httpRequest` funnel as the rest of the provider. Errors and
 * old daemons (no `capabilities` field) read as "no images" — default closed.
 */
export async function ollamaModelSupportsImages(
  baseUrl: string,
  modelId: string,
): Promise<boolean> {
  const base = baseUrl.replace(/\/+$/, "");
  const key = `${base}|${modelId}`;
  const cached = ollamaVisionCache.get(key);
  if (cached !== undefined) return cached;
  let supports = false;
  try {
    const res = await httpRequest({
      method: "POST",
      url: `${base}/api/show`,
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: modelId }),
    });
    if (res.status >= 200 && res.status < 300) {
      const parsed = JSON.parse(res.body) as OllamaShowResponse;
      supports = parsed.capabilities?.includes("vision") ?? false;
    }
  } catch {
    supports = false;
  }
  ollamaVisionCache.set(key, supports);
  return supports;
}

/**
 * One call for every provider: resolves the attach-button visibility for the
 * selected model. `ollamaBaseUrl` is only consulted for the Ollama probe.
 */
export async function modelSupportsImages(
  providerId: AiProviderId,
  modelId: string,
  ollamaBaseUrl?: string,
): Promise<boolean> {
  if (!modelId) return false;
  const fromTable = imageCapabilityFromTable(providerId, modelId);
  if (fromTable !== null) return fromTable;
  return ollamaModelSupportsImages(
    ollamaBaseUrl?.trim() || "http://localhost:11434",
    modelId,
  );
}
