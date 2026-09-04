import { describe, expect, it } from "vitest";

import type { ChatAttachment, ChatMessage } from "~/integrations/types";
import { buildAnthropicChatBody } from "./anthropic";
import { buildGeminiChatBody } from "./gemini";
import { buildOllamaChatBody } from "./ollama";
import { buildOpenAIChatBody } from "./openai";

const IMG: ChatAttachment = {
  kind: "image",
  mime: "image/png",
  base64: "aWJhc2U2NA==",
  name: "figure.png",
  bytes: 8,
};

/** Persisted stub — payload gone after reload; must never reach the wire. */
const STUB: ChatAttachment = { kind: "image", mime: "image/png", base64: "", bytes: 8 };

const TEXT_ONLY: ChatMessage[] = [
  { role: "system", content: "sys" },
  { role: "user", content: "hello" },
  { role: "assistant", content: "hi" },
];

const WITH_IMAGE: ChatMessage[] = [
  { role: "user", content: "what is in this figure?", attachments: [IMG, STUB] },
];

describe("anthropic wire shape", () => {
  it("keeps plain-string content for text-only turns and hoists system", () => {
    const body = JSON.parse(buildAnthropicChatBody(TEXT_ONLY, { model: "claude-x" }));
    expect(body.system).toBe("sys");
    expect(body.messages).toEqual([
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(body.max_tokens).toBe(4096);
    expect(body.stream).toBe(true);
  });

  it("maps attachments to base64 content blocks, images before text", () => {
    const body = JSON.parse(buildAnthropicChatBody(WITH_IMAGE, { model: "claude-x" }));
    expect(body.messages[0].content).toEqual([
      {
        type: "image",
        source: { type: "base64", media_type: "image/png", data: IMG.base64 },
      },
      { type: "text", text: "what is in this figure?" },
    ]);
  });
});

describe("openai wire shape", () => {
  it("keeps plain content and never leaks the attachments field", () => {
    const body = JSON.parse(buildOpenAIChatBody(TEXT_ONLY, { model: "gpt-4o" }));
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
  });

  it("maps attachments to image_url data URLs in a content array", () => {
    const body = JSON.parse(buildOpenAIChatBody(WITH_IMAGE, { model: "gpt-4o" }));
    expect(body.messages[0].content).toEqual([
      { type: "text", text: "what is in this figure?" },
      {
        type: "image_url",
        image_url: { url: `data:image/png;base64,${IMG.base64}` },
      },
    ]);
    expect(body.messages[0].attachments).toBeUndefined();
  });
});

describe("gemini wire shape", () => {
  it("maps roles to user/model and system to systemInstruction", () => {
    const body = JSON.parse(buildGeminiChatBody(TEXT_ONLY, { model: "gemini-x" }));
    expect(body.systemInstruction).toEqual({ parts: [{ text: "sys" }] });
    expect(body.contents).toEqual([
      { role: "user", parts: [{ text: "hello" }] },
      { role: "model", parts: [{ text: "hi" }] },
    ]);
  });

  it("adds inlineData parts for attachments", () => {
    const body = JSON.parse(buildGeminiChatBody(WITH_IMAGE, { model: "gemini-x" }));
    expect(body.contents[0].parts).toEqual([
      { text: "what is in this figure?" },
      { inlineData: { mimeType: "image/png", data: IMG.base64 } },
    ]);
  });
});

describe("ollama wire shape", () => {
  it("keeps plain messages and passes options through", () => {
    const body = JSON.parse(
      buildOllamaChatBody(TEXT_ONLY, { model: "llama3", temperature: 0.2 }),
    );
    expect(body.model).toBe("llama3");
    expect(body.messages).toEqual([
      { role: "system", content: "sys" },
      { role: "user", content: "hello" },
      { role: "assistant", content: "hi" },
    ]);
    expect(body.options.temperature).toBe(0.2);
    expect(body.stream).toBe(true);
  });

  it("maps attachments to a message-level bare-base64 images array", () => {
    const body = JSON.parse(buildOllamaChatBody(WITH_IMAGE, { model: "llava" }));
    expect(body.messages[0]).toEqual({
      role: "user",
      content: "what is in this figure?",
      images: [IMG.base64],
    });
  });
});
