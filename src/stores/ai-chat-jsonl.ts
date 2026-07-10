/**
 * Pure serialization for AI conversations — the JSONL sidecar format under
 * `<project>/.typeward/ai/conversations/<id>.jsonl`. Line 1 is a header
 * record (id/title/timestamps), then one record per turn. Kept IPC-free so
 * the round-trip is unit-testable; the store owns the file IO.
 *
 * Attachment payloads are stubbed on write (`base64: ""`) — the sidecar
 * stays small and image bytes never persist to disk. A reloaded turn renders
 * an "image — name, size" placeholder and can't be regenerated with images.
 */

import type { ChatAttachment } from "~/integrations/types";

export interface ChatTurn {
  /** makeStreamId-style base36 id. */
  id: string;
  role: "user" | "assistant";
  content: string;
  /** User turns only. In-memory turns hold payloads; loaded turns hold stubs. */
  attachments?: ChatAttachment[];
  /** Epoch ms. */
  createdAt: number;
  /** Assistant turns: what produced it. */
  model?: string;
  providerId?: string;
  /** Stop pressed mid-stream — the partial text was kept. */
  interrupted?: boolean;
}

export interface Conversation {
  id: string;
  /** First user line, capped — no rename in v1. */
  title: string;
  createdAt: number;
  updatedAt: number;
  turns: ChatTurn[];
}

interface HeaderRecord {
  v: 1;
  id: string;
  title: string;
  createdAt: number;
  updatedAt: number;
}

const TITLE_MAX = 60;

// A conversation id round-trips into fs paths (`<id>.jsonl` delete/save), so
// a hostile sidecar header must never smuggle traversal segments through it.
// Exactly the makeChatId alphabet, bounded.
const VALID_CHAT_ID = /^[a-z0-9-]{1,80}$/;

export function makeChatId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

/** Conversation title = the first non-empty line of the first user turn. */
export function deriveTitle(text: string): string {
  const line = text
    .split("\n")
    .map((l) => l.trim())
    .find((l) => l.length > 0);
  if (!line) return "New conversation";
  return line.length > TITLE_MAX ? `${line.slice(0, TITLE_MAX - 1)}…` : line;
}

function stubAttachment(a: ChatAttachment): ChatAttachment {
  return { kind: "image", mime: a.mime, base64: "", name: a.name, bytes: a.bytes };
}

export function serializeConversation(conv: Conversation): string {
  const header: HeaderRecord = {
    v: 1,
    id: conv.id,
    title: conv.title,
    createdAt: conv.createdAt,
    updatedAt: conv.updatedAt,
  };
  const lines = [JSON.stringify(header)];
  for (const turn of conv.turns) {
    lines.push(
      JSON.stringify({
        ...turn,
        attachments: turn.attachments?.map(stubAttachment),
      }),
    );
  }
  return `${lines.join("\n")}\n`;
}

function asFiniteNumber(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

function parseTurn(raw: unknown): ChatTurn | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (r.role !== "user" && r.role !== "assistant") return null;
  if (typeof r.content !== "string") return null;
  const attachments = Array.isArray(r.attachments)
    ? (r.attachments as unknown[])
        .filter(
          (a): a is Record<string, unknown> =>
            typeof a === "object" &&
            a !== null &&
            (a as Record<string, unknown>).kind === "image" &&
            typeof (a as Record<string, unknown>).mime === "string",
        )
        .map(
          (a): ChatAttachment => ({
            kind: "image",
            mime: a.mime as string,
            // Payloads never persist; whatever is on disk is display-only.
            base64: "",
            name: typeof a.name === "string" ? a.name : undefined,
            bytes: asFiniteNumber(a.bytes, 0),
          }),
        )
    : undefined;
  return {
    id: typeof r.id === "string" && r.id.length > 0 ? r.id : makeChatId(),
    role: r.role,
    content: r.content,
    attachments: attachments && attachments.length > 0 ? attachments : undefined,
    createdAt: asFiniteNumber(r.createdAt, 0),
    model: typeof r.model === "string" ? r.model : undefined,
    providerId: typeof r.providerId === "string" ? r.providerId : undefined,
    interrupted: r.interrupted === true ? true : undefined,
  };
}

/**
 * Parse one sidecar file. Returns null when the header line is unusable —
 * including an id outside the makeChatId alphabet, which would otherwise
 * reach fs paths; malformed turn lines are skipped, not fatal — a
 * partially-corrupt file still loads the turns that survived.
 */
export function parseConversation(raw: string): Conversation | null {
  const lines = raw.split("\n").filter((l) => l.trim().length > 0);
  if (lines.length === 0) return null;
  let header: HeaderRecord;
  try {
    const parsed = JSON.parse(lines[0]) as Record<string, unknown>;
    if (typeof parsed.id !== "string" || !VALID_CHAT_ID.test(parsed.id)) return null;
    header = {
      v: 1,
      id: parsed.id,
      title: typeof parsed.title === "string" ? parsed.title : "Conversation",
      createdAt: asFiniteNumber(parsed.createdAt, 0),
      updatedAt: asFiniteNumber(parsed.updatedAt, 0),
    };
  } catch {
    return null;
  }
  const turns: ChatTurn[] = [];
  for (const line of lines.slice(1)) {
    try {
      const turn = parseTurn(JSON.parse(line));
      if (turn) turns.push(turn);
    } catch {
      // Skip malformed lines — never fatal.
    }
  }
  return {
    id: header.id,
    title: header.title,
    createdAt: header.createdAt,
    updatedAt: header.updatedAt,
    turns,
  };
}
