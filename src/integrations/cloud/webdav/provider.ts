/**
 * WebDAV CloudFsProvider — path-based, HTTP Basic auth, poll-and-diff delta.
 *
 * WebDAV has no usable change cursor for file storage (RFC 6578 sync-token is
 * a CalDAV/CardDAV feature; Nextcloud/ownCloud/Apache/nginx Files don't expose
 * it). So change detection is poll-and-diff: each `delta()` re-walks the tree
 * with PROPFIND and compares ETags against a snapshot we serialize into the
 * engine cursor. ETag doubles as the `rev` for echo suppression.
 *
 * `rootId` is the chosen project folder's path relative to the account base
 * ("" = the base itself). The provider keeps two path spaces: ids are relative
 * to the account base (what the Rust IPCs take), while `RemoteFile.relPath` is
 * relative to `rootId` (what the sync cache mirrors).
 */

import { readFile, writeFile } from "@tauri-apps/plugin-fs";

import type {
  CloudFsProvider,
  DeltaChange,
  DeltaResult,
  ProviderStatus,
  RemoteFile,
  RemoteFolder,
} from "~/integrations/types";

import {
  type WebdavAccount,
  type WebdavEntry,
  webdavDelete,
  webdavGet,
  webdavPropfind,
  webdavPut,
  webdavStatusProbe,
} from "./ipc";

/** Per-file revision. Prefers the ETag; falls back to size+mtime for the rare
 * server that omits `getetag`, so the diff still detects content changes. */
function revOf(e: Pick<WebdavEntry, "etag" | "size" | "lastModified">): string {
  return e.etag ?? `s:${e.size ?? 0}:m:${e.lastModified ?? ""}`;
}

function trimSlashes(s: string): string {
  return s.replace(/^\/+|\/+$/g, "");
}

/** Join a `rootId`-relative path back into an account-base-relative id. */
function joinUnderBase(rootId: string, rel: string): string {
  const r = trimSlashes(rootId);
  const t = rel.replace(/^\/+/, "");
  return r ? `${r}/${t}` : t;
}

/** Strip the `rootId` prefix from a base-relative id to get the cache relPath. */
function stripRoot(idUnderBase: string, rootId: string): string {
  const r = trimSlashes(rootId);
  if (!r) return idUnderBase;
  return idUnderBase.startsWith(`${r}/`) ? idUnderBase.slice(r.length + 1) : idUnderBase;
}

function encodeCursor(snap: Record<string, string>): string {
  return JSON.stringify({ v: 1, snap });
}

function decodeCursor(cursor: string | undefined): Record<string, string> {
  if (!cursor) return {};
  try {
    const parsed = JSON.parse(cursor) as { v?: number; snap?: Record<string, string> };
    return parsed.snap ?? {};
  } catch {
    return {};
  }
}

export function createWebdavProvider(account: WebdavAccount): CloudFsProvider {
  // BFS over the subtree under `rootId` (base-relative; "" = base root),
  // invoking `onFile` for each file. Directories are enqueued, not emitted.
  const walk = async (rootId: string, onFile: (e: WebdavEntry) => void): Promise<void> => {
    const queue: string[] = [trimSlashes(rootId)];
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const { entries } = await webdavPropfind(account, dir, 1);
      for (const entry of entries) {
        if (entry.isDir) {
          queue.push(entry.relPath);
        } else {
          onFile(entry);
        }
      }
    }
  };

  return {
    id: `webdav:${account.accountId}`,
    category: "cloud",
    displayName: `WebDAV (${account.username})`,

    async status(): Promise<ProviderStatus> {
      try {
        return (await webdavStatusProbe(account)) ? "ready" : "error";
      } catch {
        return "error";
      }
    },

    async listRoots(): Promise<RemoteFolder[]> {
      const { entries } = await webdavPropfind(account, "", 1);
      return entries.filter((e) => e.isDir).map((e) => ({ id: e.relPath, name: e.relPath }));
    },

    async enumerateFiles(rootId: string): Promise<{ files: RemoteFile[]; cursor: string }> {
      const files: RemoteFile[] = [];
      const snap: Record<string, string> = {};
      await walk(rootId, (e) => {
        const rev = revOf(e);
        snap[e.relPath] = rev;
        files.push({
          id: e.relPath,
          relPath: stripRoot(e.relPath, rootId),
          rev,
          size: e.size,
          modifiedAt: e.lastModified,
        });
      });
      return { files, cursor: encodeCursor(snap) };
    },

    async delta(rootId: string, cursor: string | undefined): Promise<DeltaResult> {
      const prev = decodeCursor(cursor);
      const curr: Record<string, string> = {};
      const changes: DeltaChange[] = [];

      await walk(rootId, (e) => {
        const rev = revOf(e);
        curr[e.relPath] = rev;
        if (prev[e.relPath] !== rev) {
          changes.push({
            kind: prev[e.relPath] === undefined ? "added" : "modified",
            file: {
              id: e.relPath,
              relPath: stripRoot(e.relPath, rootId),
              rev,
              size: e.size,
              modifiedAt: e.lastModified,
            },
          });
        }
      });

      for (const id of Object.keys(prev)) {
        if (!(id in curr)) {
          changes.push({ kind: "removed", relPath: stripRoot(id, rootId) });
        }
      }

      return { changes, nextCursor: encodeCursor(curr), hasMore: false };
    },

    async downloadFile(file: RemoteFile, destAbsPath: string): Promise<void> {
      const res = await webdavGet(account, file.id);
      await writeFile(destAbsPath, res.body);
    },

    async uploadFile(rootId: string, relPath: string, sourceAbsPath: string): Promise<RemoteFile> {
      const bytes = await readFile(sourceAbsPath);
      const idUnderBase = joinUnderBase(rootId, relPath);
      const res = await webdavPut(account, idUnderBase, bytes);
      return { id: idUnderBase, relPath, rev: res.etag, size: bytes.length };
    },

    async deleteRemoteFile(_rootId: string, file: RemoteFile): Promise<void> {
      await webdavDelete(account, file.id);
    },
  };
}
