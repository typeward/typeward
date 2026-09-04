/**
 * Typed wrappers over the Rust `webdav_*` IPC commands. All WebDAV transport,
 * SSRF screening, Basic auth, and multistatus XML parsing live in Rust
 * (`src-tauri/src/integrations/webdav.rs`); the frontend only ever sees parsed
 * entries and file bytes, never raw server XML.
 */

import { invoke } from "@tauri-apps/api/core";

import { unframeMetaBody } from "~/integrations/ipc-frame";

/** Mirrors the Rust `WebdavAccount`. The password is never carried here — it is
 * read from the keyring in Rust under service `webdav` / account `accountId`. */
export interface WebdavAccount {
  accountId: string;
  /** Normalized base collection URL, always ending in `/`. */
  baseUrl: string;
  username: string;
  allowPrivateHost: boolean;
}

export interface WebdavEntry {
  /** Path relative to the account base; directories carry no trailing slash. */
  relPath: string;
  isDir: boolean;
  etag?: string;
  size?: number;
  lastModified?: string;
}

export interface HostVerdict {
  ok: boolean;
  host: string;
  port: number;
  basePath: string;
  baseUrl: string;
  reason?: string;
}

export const webdavValidateHost = (url: string, allowPrivate: boolean): Promise<HostVerdict> =>
  invoke("webdav_validate_host", { url, allowPrivate });

export const webdavStatusProbe = (account: WebdavAccount): Promise<boolean> =>
  invoke("webdav_status_probe", { account });

/** Verify credentials for an account that is not in settings yet. Every other
 * `webdav_*` command requires an enrolled account, which the very first
 * connection cannot be — see the Rust doc comment on `webdav_enroll_probe`. */
export const webdavEnrollProbe = (account: WebdavAccount): Promise<boolean> =>
  invoke("webdav_enroll_probe", { account });

export const webdavPropfind = (
  account: WebdavAccount,
  relPath: string,
  depth: number,
): Promise<{ entries: WebdavEntry[] }> =>
  invoke("webdav_propfind", { account, relPath, depth });

export const webdavGet = async (
  account: WebdavAccount,
  relPath: string,
): Promise<{ etag?: string; body: Uint8Array }> => {
  // File bytes come back as a framed raw ArrayBuffer (etag in the JSON prefix,
  // bytes raw) instead of a JSON number array — see ipc-frame.ts.
  const buf = await invoke<ArrayBuffer>("webdav_get", { account, relPath });
  const { meta, body } = unframeMetaBody<{ etag?: string }>(buf);
  return { etag: meta.etag, body };
};

export const webdavPut = (
  account: WebdavAccount,
  relPath: string,
  body: Uint8Array,
  ifMatch?: string,
): Promise<{ etag?: string }> =>
  // Upload bytes ride as the raw IPC body (no JSON number-array bloat); the
  // account/path/if-match metadata travels as percent-encoded headers.
  invoke("webdav_put", body, {
    headers: {
      "x-webdav-account": encodeURIComponent(JSON.stringify(account)),
      "x-rel-path": encodeURIComponent(relPath),
      ...(ifMatch ? { "x-if-match": encodeURIComponent(ifMatch) } : {}),
    },
  });

/** Create a collection (with any missing ancestors). Idempotent server-side. */
export const webdavMkcol = (account: WebdavAccount, relPath: string): Promise<void> =>
  invoke("webdav_mkcol", { account, relPath });

export const webdavDelete = (
  account: WebdavAccount,
  relPath: string,
  ifMatch?: string,
): Promise<void> => invoke("webdav_delete", { account, relPath, ifMatch });
