/**
 * Outbound HTTP. All third-party traffic funnels through this; the
 * frontend never holds an access token, never sees raw `fetch` against an
 * external host. The Rust side fetches the secret from the keyring and
 * attaches the auth header before the wire.
 */

import { invoke } from "@tauri-apps/api/core";

import type { CredentialRef } from "./auth/credentials";
import { unframeMetaBody } from "./ipc-frame";

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
  // The response body comes back as a framed raw ArrayBuffer (status + headers
  // in the small JSON prefix, file bytes raw) so a download doesn't pay the
  // ~3-4x JSON number-array bloat. The upload body still rides as a JSON array.
  const buf = await invoke<ArrayBuffer>("http_request_bytes", {
    req: {
      method: req.method,
      url: req.url,
      headers: req.headers ?? {},
      body: req.body ? Array.from(req.body) : undefined,
      authRef: req.authRef,
    },
  });
  const { meta, body } = unframeMetaBody<{
    status: number;
    headers: Record<string, string>;
  }>(buf);
  return { status: meta.status, headers: meta.headers, body };
};
