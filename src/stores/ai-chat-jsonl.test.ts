import { describe, expect, it } from "vitest";

import { extractInsertText, quoteForDraft } from "~/integrations/ai/chat-text";
import {
  type Conversation,
  deriveTitle,
  parseConversation,
  serializeConversation,
} from "./ai-chat-jsonl";

const CONV: Conversation = {
  id: "abc123",
  title: "Fix my abstract",
  createdAt: 1000,
  updatedAt: 2000,
  turns: [
    {
      id: "t1",
      role: "user",
      content: "Fix my abstract",
      createdAt: 1000,
      attachments: [
        { kind: "image", mime: "image/png", base64: "QUJD", name: "fig.png", bytes: 3 },
      ],
    },
    {
      id: "t2",
      role: "assistant",
      content: "Here you go.",
      createdAt: 1500,
      model: "claude-x",
      providerId: "anthropic",
      interrupted: true,
    },
  ],
};

describe("serializeConversation / parseConversation", () => {
  it("round-trips header and turns, stubbing attachment payloads", () => {
    const raw = serializeConversation(CONV);
    const lines = raw.trim().split("\n");
    expect(lines).toHaveLength(3);
    // Line 1 = header record.
    expect(JSON.parse(lines[0])).toMatchObject({
      v: 1,
      id: "abc123",
      title: "Fix my abstract",
    });
    // Payload never persists.
    expect(raw).not.toContain("QUJD");

    const parsed = parseConversation(raw)!;
    expect(parsed.id).toBe("abc123");
    expect(parsed.turns).toHaveLength(2);
    expect(parsed.turns[0].attachments).toEqual([
      { kind: "image", mime: "image/png", base64: "", name: "fig.png", bytes: 3 },
    ]);
    expect(parsed.turns[1]).toMatchObject({
      role: "assistant",
      model: "claude-x",
      providerId: "anthropic",
      interrupted: true,
    });
  });

  it("skips malformed turn lines without failing the file", () => {
    const raw = [
      JSON.stringify({ v: 1, id: "x", title: "t", createdAt: 1, updatedAt: 2 }),
      "{not json",
      JSON.stringify({ role: "wizard", content: "invalid role" }),
      JSON.stringify({ role: "user", content: "kept", createdAt: 5 }),
    ].join("\n");
    const parsed = parseConversation(raw)!;
    expect(parsed.turns).toHaveLength(1);
    expect(parsed.turns[0].content).toBe("kept");
  });

  it("returns null for an unusable header", () => {
    expect(parseConversation("")).toBeNull();
    expect(parseConversation("not json\n")).toBeNull();
    expect(parseConversation(`${JSON.stringify({ title: "no id" })}\n`)).toBeNull();
  });
});

describe("deriveTitle", () => {
  it("takes the first non-empty line", () => {
    expect(deriveTitle("\n\nRewrite this paragraph\nplease")).toBe(
      "Rewrite this paragraph",
    );
  });
  it("caps at 60 chars with an ellipsis", () => {
    const long = "a".repeat(80);
    const title = deriveTitle(long);
    expect(title.length).toBe(60);
    expect(title.endsWith("…")).toBe(true);
  });
  it("falls back for empty drafts", () => {
    expect(deriveTitle("   \n ")).toBe("New conversation");
  });
});

describe("extractInsertText", () => {
  it("returns the body of a single fenced block", () => {
    const msg = "Here is the fix:\n```latex\n\\section{Intro}\n```\nDone.";
    expect(extractInsertText(msg)).toBe("\\section{Intro}");
  });
  it("returns the whole text when there are no fences", () => {
    expect(extractInsertText("plain answer")).toBe("plain answer");
  });
  it("returns the whole text when there are multiple fences", () => {
    const msg = "```a\none\n```\ntext\n```b\ntwo\n```";
    expect(extractInsertText(msg)).toBe(msg);
  });
});

describe("quoteForDraft", () => {
  it("prefixes each selection line and leaves room to type", () => {
    expect(quoteForDraft("line one\nline two\n")).toBe(
      "> line one\n> line two\n\n",
    );
  });
});
