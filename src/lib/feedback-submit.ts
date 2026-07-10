/**
 * In-app feedback submission — POSTs to the `submit-feedback` Supabase edge
 * function (infrastructure repo), which forwards to n8n triage (plan 50 §2).
 *
 * The endpoint is deliberately JWT-free and its CORS allows only the
 * `content-type` header, so this is a bare fetch with no apikey/auth header
 * (adding one would fail the preflight). The URL derives from the same env
 * config as the Supabase client; an unconfigured build throws and the card
 * falls back to the GitHub-prefill report (bug-report.ts).
 *
 * Payload mirrors the function contract field-for-field:
 *   description  required, <= 4000 chars
 *   email        optional, <= 200 chars, basic shape check
 *   systemInfo   optional object, <= 2000 chars serialized
 * The contract also accepts `log`, which is never sent — feedback carries
 * what the user typed plus app version/OS, nothing else (privacy stance).
 */

import { loadSupabaseConfig } from "~/config/supabase";
import type { SystemInfo } from "~/ipc";

export const FEEDBACK_MAX_DESCRIPTION = 4000;
export const FEEDBACK_MAX_EMAIL = 200;

export interface FeedbackPayload {
  description: string;
  email?: string;
  systemInfo?: {
    appVersion: string;
    os: string;
    osVersion: string;
    arch: string;
  };
}

/** Same shape check as the edge function, run client-side so an invalid
 *  address fails with an inline hint instead of a wire round-trip. */
export function isValidFeedbackEmail(email: string): boolean {
  return (
    email.length <= FEEDBACK_MAX_EMAIL && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)
  );
}

export function buildFeedbackPayload(
  description: string,
  email: string,
  info: SystemInfo | null,
): FeedbackPayload {
  const payload: FeedbackPayload = {
    description: description.trim().slice(0, FEEDBACK_MAX_DESCRIPTION),
  };
  const trimmedEmail = email.trim();
  if (trimmedEmail) payload.email = trimmedEmail;
  if (info) {
    // App version + OS only — never tool probes, paths, engines, or logs.
    payload.systemInfo = {
      appVersion: info.appVersion,
      os: info.os,
      osVersion: info.osVersion,
      arch: info.arch,
    };
  }
  return payload;
}

/** null when the build has no Supabase env config (feedback unavailable). */
export function feedbackEndpoint(): string | null {
  const config = loadSupabaseConfig();
  if (!config) return null;
  return `${config.url.replace(/\/+$/, "")}/functions/v1/submit-feedback`;
}

export async function submitFeedback(payload: FeedbackPayload): Promise<void> {
  const endpoint = feedbackEndpoint();
  if (!endpoint) {
    throw new Error("Feedback isn't configured in this build.");
  }
  const res = await fetch(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.ok) return;
  // 503 = the function's n8n forward isn't configured yet (its documented
  // "try later / use the GitHub stopgap" signal).
  if (res.status === 503) {
    throw new Error("The feedback service isn't available right now.");
  }
  let message = `Feedback submission failed (${res.status}).`;
  try {
    const body = (await res.json()) as { error?: string } | null;
    if (body?.error) message = body.error;
  } catch {
    // Non-JSON error body — keep the status message.
  }
  throw new Error(message);
}
