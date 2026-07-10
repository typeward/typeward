import { afterEach, describe, expect, it, vi } from "vitest";

import type { SystemInfo } from "~/ipc";

// Pin the Supabase config so endpoint derivation is testable regardless of
// the dev host's .env.local.
vi.mock("~/config/supabase", () => ({
  loadSupabaseConfig: () => ({
    url: "https://example.supabase.co/",
    anonKey: "sb_publishable_test",
  }),
}));

import {
  FEEDBACK_MAX_DESCRIPTION,
  buildFeedbackPayload,
  feedbackEndpoint,
  isValidFeedbackEmail,
  submitFeedback,
} from "./feedback-submit";

const INFO: SystemInfo = {
  appVersion: "0.0.1",
  os: "Windows",
  osVersion: "11",
  arch: "x86_64",
  compileEngine: "system-tex",
  tools: [
    { name: "latexmk", found: true },
    { name: "typst", found: false },
  ],
};

afterEach(() => {
  vi.unstubAllGlobals();
});

// The payload must match the submit-feedback edge function contract
// field-for-field (infrastructure/supabase/functions/submit-feedback).
describe("buildFeedbackPayload", () => {
  it("sends only contract fields — no log, no extras", () => {
    const payload = buildFeedbackPayload("Great app", "a@b.cz", INFO);
    expect(Object.keys(payload).sort()).toEqual(["description", "email", "systemInfo"]);
    expect(payload).not.toHaveProperty("log");
  });

  it("trims and caps the description at the function's 4000-char limit", () => {
    expect(buildFeedbackPayload("  hi  ", "", null).description).toBe("hi");
    const long = "x".repeat(FEEDBACK_MAX_DESCRIPTION + 100);
    expect(buildFeedbackPayload(long, "", null).description.length).toBe(
      FEEDBACK_MAX_DESCRIPTION,
    );
  });

  it("omits the email field entirely when blank", () => {
    expect(buildFeedbackPayload("hi", "", null)).not.toHaveProperty("email");
    expect(buildFeedbackPayload("hi", "   ", null)).not.toHaveProperty("email");
    expect(buildFeedbackPayload("hi", " a@b.cz ", null).email).toBe("a@b.cz");
  });

  it("limits systemInfo to app version + OS facts, well under the 2000-char cap", () => {
    const payload = buildFeedbackPayload("hi", "", INFO);
    expect(payload.systemInfo).toEqual({
      appVersion: "0.0.1",
      os: "Windows",
      osVersion: "11",
      arch: "x86_64",
    });
    // No tool probes, engines, or paths — the privacy stance for feedback.
    expect(JSON.stringify(payload.systemInfo)).not.toContain("latexmk");
    expect(JSON.stringify(payload.systemInfo).length).toBeLessThan(2000);
  });

  it("omits systemInfo when the probe failed", () => {
    expect(buildFeedbackPayload("hi", "", null)).not.toHaveProperty("systemInfo");
  });
});

describe("isValidFeedbackEmail", () => {
  it("mirrors the edge function's shape check", () => {
    expect(isValidFeedbackEmail("a@b.cz")).toBe(true);
    expect(isValidFeedbackEmail("first.last+tag@sub.example.com")).toBe(true);
    expect(isValidFeedbackEmail("nope")).toBe(false);
    expect(isValidFeedbackEmail("a b@c.dz")).toBe(false);
    expect(isValidFeedbackEmail("a@b")).toBe(false);
    expect(isValidFeedbackEmail("a@" + "b".repeat(200) + ".cz")).toBe(false); // > 200 chars
  });
});

describe("submitFeedback", () => {
  it("derives the endpoint from the Supabase config (trailing slash stripped)", () => {
    expect(feedbackEndpoint()).toBe(
      "https://example.supabase.co/functions/v1/submit-feedback",
    );
  });

  it("POSTs JSON with only a content-type header (the CORS allowlist)", async () => {
    const fetchMock = vi.fn(async () => new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    await submitFeedback({ description: "hi" });
    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://example.supabase.co/functions/v1/submit-feedback");
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "Content-Type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual({ description: "hi" });
  });

  it("maps the 503 backend-unconfigured case to an actionable message", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"feedback backend not configured"}', { status: 503 })),
    );
    await expect(submitFeedback({ description: "hi" })).rejects.toThrow(
      /isn't available right now/,
    );
  });

  it("surfaces the function's error message on other failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => new Response('{"error":"description too long"}', { status: 400 })),
    );
    await expect(submitFeedback({ description: "hi" })).rejects.toThrow(
      "description too long",
    );
  });

  it("propagates network failures", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("Failed to fetch");
      }),
    );
    await expect(submitFeedback({ description: "hi" })).rejects.toThrow("Failed to fetch");
  });
});
