/**
 * Outbound HTTP. All third-party traffic funnels through this; the
 * frontend never holds an access token, never sees raw `fetch` against an
 * external host. The Rust side fetches the secret from the keyring and
 * attaches the auth header before the wire.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CredentialRef } from "./auth/credentials";

export interface HttpAuthRef extends CredentialRef {
  /** Header name. Defaults to `Authorization`. */
  header?: string;
  /** Value prefix, e.g. `"Bearer "` (note trailing space). */
  prefix?: string;
}

export interface HttpRequest {
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD";
  url: string;
  headers?: Record<string, string>;
  body?: string;
  /**
   * Optional credential reference. The Rust side reads the secret from the
   * keyring and attaches it to the named header. Frontend never holds it.
   */
  authRef?: HttpAuthRef;
}

export interface HttpResponse {
  status: number;
  headers: Record<string, string>;
  body: string;
}

export const httpRequest = (req: HttpRequest): Promise<HttpResponse> =>
  invoke<HttpResponse>("http_request", {
    req: {
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      body: req.body,
      authRef: req.authRef,
    },
  });

/**
 * Convenience for JSON endpoints. Parses the response body or throws.
 * Status codes outside 2xx still resolve — caller decides what to do
 * with them; we don't want to discard the error body that providers
 * typically return.
 */
export async function httpJson<T>(req: HttpRequest): Promise<{ status: number; data: T }> {
  const res = await httpRequest({
    ...req,
    headers: { Accept: "application/json", ...(req.headers ?? {}) },
  });
  return { status: res.status, data: JSON.parse(res.body) as T };
}
