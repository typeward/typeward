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

import { describeIpcError } from "~/lib/errors";

import type {
  CloudFsProvider,
  DeltaChange,
  DeltaResult,
  ProviderStatus,
  RemoteFile,
  RemoteFolder,
} from "~/integrations/types";

import { CLOUD_PROJECTS_FOLDER } from "../core/remote-root";

import {
  type WebdavAccount,
  type WebdavEntry,
  webdavDelete,
  webdavGet,
  webdavMkcol,
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

/** Rust surfaces a non-2xx as `WebdavError::Status { status, detail }`, which
 * crosses the bridge as its Display string — so the code is matched textually. */
function isPreconditionFailed(err: unknown): boolean {
  return /\b412\b/.test(describeIpcError(err));
}

/** 404 from a PROPFIND on the projects folder just means nothing is there yet. */
function isNotFound(err: unknown): boolean {
  return /\b404\b/.test(describeIpcError(err));
}

/**
 * Bounds for the PROPFIND tree walk. Remote content is attacker-controlled in
 * this project's threat model, and a server whose listings cycle (A lists B, B
 * lists A — trivial to serve, and reachable on real servers via loop mounts)
 * would otherwise spin the pull pass forever. Because the engine serializes
 * everything through one promise chain, that also means queued pushes never
 * drain and `SyncEngine.stop()` never resolves, so closing or switching the
 * project hangs.
 */
const MAX_WALK_ENTRIES = 20_000;

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
    const start = trimSlashes(rootId);
    const queue: string[] = [start];
    // Directories already listed. A cycling listing would otherwise re-enqueue
    // forever; a merely huge tree is caught by the entry cap below.
    const visited = new Set<string>([start]);
    let seen = 0;
    while (queue.length > 0) {
      const dir = queue.shift() as string;
      const { entries } = await webdavPropfind(account, dir, 1);
      for (const entry of entries) {
        if (++seen > MAX_WALK_ENTRIES) {
          throw new Error(
            `Remote folder listing exceeded ${MAX_WALK_ENTRIES} entries. Pick a narrower project folder, or check the server for a directory loop.`,
          );
        }
        if (entry.isDir) {
          if (visited.has(entry.relPath)) continue;
          visited.add(entry.relPath);
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
      // Scoped to the shared projects folder rather than the account root. That
      // folder is created on demand at the first project create, so "not there
      // yet" has to read as an empty list, not an error.
      let entries;
      try {
        ({ entries } = await webdavPropfind(account, CLOUD_PROJECTS_FOLDER, 1));
      } catch (err) {
        if (isNotFound(err)) return [];
        throw err;
      }
      return entries
        .filter((e) => e.isDir)
        .map((e) => ({ id: e.relPath, name: e.relPath.split("/").pop() ?? e.relPath }));
    },

    async ensureFolder(id: string): Promise<void> {
      await webdavMkcol(account, trimSlashes(id));
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

    async uploadFile(
      rootId: string,
      relPath: string,
      sourceAbsPath: string,
      expectedRev?: string,
    ): Promise<RemoteFile> {
      const bytes = await readFile(sourceAbsPath);
      const idUnderBase = joinUnderBase(rootId, relPath);
      // Conditional on the revision we last synced: the server rejects the PUT
      // with 412 if anyone changed the file since, instead of us overwriting
      // their edit. First upload of a path has no rev and stays unconditional.
      try {
        const res = await webdavPut(account, idUnderBase, bytes, expectedRev);
        return { id: idUnderBase, relPath, rev: res.etag, size: bytes.length };
      } catch (err) {
        if (expectedRev && isPreconditionFailed(err)) {
          throw new Error(
            `"${relPath}" changed on the server since it was last synced; the upload was skipped so the remote edit isn't overwritten. It will be reconciled on the next pull.`,
          );
        }
        throw err;
      }
    },

    async deleteRemoteFile(_rootId: string, file: RemoteFile): Promise<void> {
      // Same guard on the destructive path: only delete the revision we know.
      await webdavDelete(account, file.id, file.rev);
    },
  };
}
