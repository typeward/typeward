/**
 * Dropbox CloudFsProvider — path-based, OAuth bearer.
 *
 * Dropbox paths double as ids — they're stable and human-readable. We
 * store the path as the `RemoteFile.id`; deletions and re-uploads use it
 * directly. The opaque `id:xxx` Dropbox also exposes is unused.
 *
 * For initial enumeration + change tracking we use
 * `/2/files/list_folder` (recursive) → produces a cursor, then poll
 * `/2/files/list_folder/continue` for subsequent passes. Longpoll
 * (`/2/files/list_folder/longpoll` on the notify subdomain) is a future
 * latency improvement.
 */

import { readFile, writeFile } from "@tauri-apps/plugin-fs";

import { httpRequest, httpRequestBytes } from "~/integrations/http";
import type {
  CloudFsProvider,
  DeltaChange,
  DeltaResult,
  ProviderStatus,
  RemoteFile,
  RemoteFolder,
} from "~/integrations/types";

import { type DropboxAccount, getAccessToken } from "./auth";

const API = "https://api.dropboxapi.com";
const CONTENT = "https://content.dropboxapi.com";

interface DropboxFileEntry {
  ".tag": "file";
  id: string;
  name: string;
  path_display: string;
  path_lower: string;
  rev: string;
  size: number;
  server_modified?: string;
}

interface DropboxFolderEntry {
  ".tag": "folder";
  id: string;
  name: string;
  path_display: string;
  path_lower: string;
}

interface DropboxDeletedEntry {
  ".tag": "deleted";
  name: string;
  path_display: string;
  path_lower: string;
}

type DropboxEntry = DropboxFileEntry | DropboxFolderEntry | DropboxDeletedEntry;

interface ListFolderResult {
  entries: DropboxEntry[];
  cursor: string;
  has_more: boolean;
}

export function createDropboxProvider(account: DropboxAccount): CloudFsProvider {
  const auth = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await getAccessToken(account.accountId)}`,
  });

  const apiCall = async <T>(path: string, body: object): Promise<T> => {
    const res = await httpRequest({
      method: "POST",
      url: `${API}${path}`,
      headers: {
        ...(await auth()),
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`Dropbox ${path} failed (status ${res.status}): ${res.body}`);
    }
    return JSON.parse(res.body) as T;
  };

  return {
    id: `dropbox:${account.accountId}`,
    category: "cloud",
    displayName: `Dropbox (${account.displayName})`,

    async status(): Promise<ProviderStatus> {
      try {
        await getAccessToken(account.accountId);
        return "ready";
      } catch {
        return "unconfigured";
      }
    },

    async listRoots(): Promise<RemoteFolder[]> {
      // Top-level entries under the user's Dropbox. Each subfolder is a
      // candidate project root.
      const result = await apiCall<ListFolderResult>("/2/files/list_folder", {
        path: "",
        recursive: false,
      });
      return result.entries
        .filter((e): e is DropboxFolderEntry => e[".tag"] === "folder")
        .map((e) => ({ id: e.path_lower, name: e.name }));
    },

    async enumerateFiles(rootId: string): Promise<{ files: RemoteFile[]; cursor: string }> {
      const initial = await apiCall<ListFolderResult>("/2/files/list_folder", {
        path: rootId,
        recursive: true,
        include_deleted: false,
      });

      const files: RemoteFile[] = [];
      let cursor = initial.cursor;
      let hasMore = initial.has_more;
      let entries = initial.entries;

      while (true) {
        for (const entry of entries) {
          if (entry[".tag"] !== "file") continue;
          files.push(toRemoteFile(entry, rootId));
        }
        if (!hasMore) break;
        const more = await apiCall<ListFolderResult>("/2/files/list_folder/continue", {
          cursor,
        });
        cursor = more.cursor;
        hasMore = more.has_more;
        entries = more.entries;
      }

      return { files, cursor };
    },

    async delta(rootId: string, cursor: string | undefined): Promise<DeltaResult> {
      const result = cursor
        ? await apiCall<ListFolderResult>("/2/files/list_folder/continue", { cursor })
        : await apiCall<ListFolderResult>("/2/files/list_folder", {
            path: rootId,
            recursive: true,
            include_deleted: true,
          });

      const changes: DeltaChange[] = [];
      for (const entry of result.entries) {
        if (entry[".tag"] === "file") {
          const file = toRemoteFile(entry, rootId);
          changes.push({ kind: "modified", file });
        } else if (entry[".tag"] === "deleted") {
          const relPath = relPathFromAbsolute(entry.path_lower, rootId);
          if (relPath !== null) {
            changes.push({ kind: "removed", relPath });
          }
        }
        // Folder entries themselves don't drive sync; their contents do.
      }

      return {
        changes,
        nextCursor: result.cursor,
        hasMore: result.has_more,
      };
    },

    async downloadFile(file: RemoteFile, destAbsPath: string): Promise<void> {
      const res = await httpRequestBytes({
        method: "POST",
        url: `${CONTENT}/2/files/download`,
        headers: {
          ...(await auth()),
          // The Dropbox-API-Arg header carries the JSON payload that
          // would normally be the body — the body itself is reserved
          // for the file bytes (download) or upload bytes.
          "Dropbox-API-Arg": JSON.stringify({ path: file.id }),
        },
      });
      if (res.status < 200 || res.status >= 300) {
        const text = new TextDecoder().decode(res.body);
        throw new Error(`Dropbox download failed (status ${res.status}): ${text}`);
      }
      await writeFile(destAbsPath, res.body);
    },

    async uploadFile(rootId, relPath, sourceAbsPath): Promise<RemoteFile> {
      const bytes = await readFile(sourceAbsPath);
      const target = joinRemote(rootId, relPath);
      const res = await httpRequestBytes({
        method: "POST",
        url: `${CONTENT}/2/files/upload`,
        headers: {
          ...(await auth()),
          "Content-Type": "application/octet-stream",
          "Dropbox-API-Arg": JSON.stringify({
            path: target,
            mode: "overwrite",
            mute: true,
          }),
        },
        body: bytes,
      });
      if (res.status < 200 || res.status >= 300) {
        const text = new TextDecoder().decode(res.body);
        throw new Error(`Dropbox upload failed (status ${res.status}): ${text}`);
      }
      const metadata = JSON.parse(new TextDecoder().decode(res.body)) as DropboxFileEntry;
      return toRemoteFile(metadata, rootId);
    },

    async deleteRemoteFile(_rootId, file): Promise<void> {
      await apiCall<unknown>("/2/files/delete_v2", { path: file.id });
    },
  };
}

function toRemoteFile(entry: DropboxFileEntry, rootId: string): RemoteFile {
  return {
    id: entry.path_lower,
    relPath: relPathFromAbsolute(entry.path_lower, rootId) ?? entry.name,
    rev: entry.rev,
    size: entry.size,
    modifiedAt: entry.server_modified,
  };
}

function relPathFromAbsolute(absLower: string, rootIdLower: string): string | null {
  const rootPrefix = rootIdLower.endsWith("/") ? rootIdLower : rootIdLower + "/";
  if (rootIdLower === "" || rootIdLower === "/") {
    return absLower.replace(/^\/+/, "");
  }
  if (!absLower.startsWith(rootPrefix) && absLower !== rootIdLower) return null;
  return absLower.slice(rootPrefix.length);
}

function joinRemote(rootId: string, relPath: string): string {
  const base = rootId === "" || rootId === "/" ? "" : rootId.replace(/\/+$/, "");
  const tail = relPath.replace(/^\/+/, "");
  return `${base}/${tail}`;
}
