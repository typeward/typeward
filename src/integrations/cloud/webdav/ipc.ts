/**
 * Typed wrappers over the Rust `webdav_*` IPC commands. All WebDAV transport,
 * SSRF screening, Basic auth, and multistatus XML parsing live in Rust
 * (`src-tauri/src/integrations/webdav.rs`); the frontend only ever sees parsed
 * entries and file bytes, never raw server XML.
 */

import { invoke } from "@tauri-apps/api/core";

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

export const webdavPropfind = (
  account: WebdavAccount,
  relPath: string,
  depth: number,
): Promise<{ entries: WebdavEntry[] }> =>
  invoke("webdav_propfind", { account, relPath, depth });

export const webdavGet = (
  account: WebdavAccount,
  relPath: string,
): Promise<{ etag?: string; body: number[] }> => invoke("webdav_get", { account, relPath });

export const webdavPut = (
  account: WebdavAccount,
  relPath: string,
  body: number[],
  ifMatch?: string,
): Promise<{ etag?: string }> => invoke("webdav_put", { account, relPath, body, ifMatch });

export const webdavDelete = (
  account: WebdavAccount,
  relPath: string,
  ifMatch?: string,
): Promise<void> => invoke("webdav_delete", { account, relPath, ifMatch });
