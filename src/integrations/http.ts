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
  /** Public OAuth client id used by Rust to refresh token bundles. */
  clientId?: string;
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

export interface BinaryHttpRequest {
  method: HttpRequest["method"];
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  authRef?: HttpAuthRef;
}

export interface BinaryHttpResponse {
  status: number;
  headers: Record<string, string>;
  body: Uint8Array;
}

/**
 * Binary-safe HTTP. Use for cloud-provider file IO where the wire
 * payload is arbitrary bytes (not UTF-8). Slower per request than the
 * text-mode variant — only reach for it when bytes actually matter.
 */
export const httpRequestBytes = async (
  req: BinaryHttpRequest,
): Promise<BinaryHttpResponse> => {
  const res = await invoke<{
    status: number;
    headers: Record<string, string>;
    body: number[];
  }>("http_request_bytes", {
    req: {
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      body: req.body ? Array.from(req.body) : undefined,
      authRef: req.authRef,
    },
  });
  return {
    status: res.status,
    headers: res.headers,
    body: Uint8Array.from(res.body),
  };
};

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
