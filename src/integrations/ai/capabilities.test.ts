import { beforeEach, describe, expect, it, vi } from "vitest";

const httpRequestMock = vi.hoisted(() => vi.fn());
vi.mock("~/integrations/http", () => ({ httpRequest: httpRequestMock }));

import {
  _resetOllamaVisionCacheForTests,
  imageCapabilityFromTable,
  modelSupportsImages,
  ollamaModelSupportsImages,
} from "./capabilities";

describe("imageCapabilityFromTable", () => {
  it("allows every claude-* id for anthropic", () => {
    expect(imageCapabilityFromTable("anthropic", "claude-sonnet-4-5")).toBe(true);
    expect(imageCapabilityFromTable("anthropic", "claude-3-5-haiku-20241022")).toBe(true);
  });

  it("stays closed for non-matching anthropic ids", () => {
    expect(imageCapabilityFromTable("anthropic", "not-a-claude")).toBe(false);
  });

  it("matches the openai allow rows and keeps the rest closed", () => {
    expect(imageCapabilityFromTable("openai", "gpt-4o")).toBe(true);
    expect(imageCapabilityFromTable("openai", "gpt-4o-mini")).toBe(true);
    expect(imageCapabilityFromTable("openai", "gpt-4.1")).toBe(true);
    expect(imageCapabilityFromTable("openai", "gpt-5")).toBe(true);
    expect(imageCapabilityFromTable("openai", "o3")).toBe(true);
    expect(imageCapabilityFromTable("openai", "o4-mini")).toBe(true);

    expect(imageCapabilityFromTable("openai", "gpt-3.5-turbo")).toBe(false);
    expect(imageCapabilityFromTable("openai", "o1-mini")).toBe(false);
    expect(imageCapabilityFromTable("openai", "o3-mini")).toBe(false);
    // "gpt-40" must not ride the gpt-4.1 rule's unescaped-dot trap.
    expect(imageCapabilityFromTable("openai", "gpt-40")).toBe(false);
  });

  it("allows gemini-* and closes gemma-* for gemini", () => {
    expect(imageCapabilityFromTable("gemini", "gemini-2.5-pro")).toBe(true);
    expect(imageCapabilityFromTable("gemini", "gemma-3-27b-it")).toBe(false);
  });

  it("returns null for ollama (live probe, not a table)", () => {
    expect(imageCapabilityFromTable("ollama", "llava:13b")).toBeNull();
  });
});

describe("ollamaModelSupportsImages", () => {
  beforeEach(() => {
    _resetOllamaVisionCacheForTests();
    httpRequestMock.mockReset();
  });

  it("reads vision from the /api/show capabilities array", async () => {
    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ capabilities: ["completion", "vision"] }),
    });
    await expect(
      ollamaModelSupportsImages("http://localhost:11434", "llava:13b"),
    ).resolves.toBe(true);
    expect(httpRequestMock).toHaveBeenCalledWith({
      method: "POST",
      url: "http://localhost:11434/api/show",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model: "llava:13b" }),
    });
  });

  it("defaults closed for daemons without the capabilities field", async () => {
    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ modelfile: "..." }),
    });
    await expect(
      ollamaModelSupportsImages("http://localhost:11434", "llama3:8b"),
    ).resolves.toBe(false);
  });

  it("defaults closed on probe failure", async () => {
    httpRequestMock.mockRejectedValue(new Error("connection refused"));
    await expect(
      ollamaModelSupportsImages("http://localhost:11434", "llava:13b"),
    ).resolves.toBe(false);
  });

  it("caches per base+model so repeat lookups skip the wire", async () => {
    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ capabilities: ["vision"] }),
    });
    await ollamaModelSupportsImages("http://localhost:11434", "llava:13b");
    await ollamaModelSupportsImages("http://localhost:11434/", "llava:13b");
    expect(httpRequestMock).toHaveBeenCalledTimes(1);
  });
});

describe("modelSupportsImages", () => {
  beforeEach(() => {
    _resetOllamaVisionCacheForTests();
    httpRequestMock.mockReset();
  });

  it("resolves cloud providers from the table without touching the wire", async () => {
    await expect(modelSupportsImages("anthropic", "claude-sonnet-4-5")).resolves.toBe(true);
    await expect(modelSupportsImages("openai", "gpt-3.5-turbo")).resolves.toBe(false);
    expect(httpRequestMock).not.toHaveBeenCalled();
  });

  it("returns false for an empty model id", async () => {
    await expect(modelSupportsImages("anthropic", "")).resolves.toBe(false);
  });

  it("routes ollama through the live probe with the default base url", async () => {
    httpRequestMock.mockResolvedValue({
      status: 200,
      headers: {},
      body: JSON.stringify({ capabilities: ["vision"] }),
    });
    await expect(modelSupportsImages("ollama", "llava:13b")).resolves.toBe(true);
    expect(httpRequestMock.mock.calls[0][0].url).toBe(
      "http://localhost:11434/api/show",
    );
  });
});
