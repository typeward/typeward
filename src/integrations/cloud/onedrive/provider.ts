/**
 * OneDrive CloudFsProvider via Microsoft Graph.
 *
 * Drives are id-based (the same file can be renamed without losing
 * identity); we use Graph's opaque item id as `RemoteFile.id`. Paths
 * relative to the project root are derived from `parentReference.path`
 * (`/drive/root:/projects/foo`) — Graph strips its `/drive/root:`
 * prefix when the path is at the root.
 *
 * Phase 2.3 uses Graph's simple upload (good for <4 MB). Larger files
 * need an upload session; left for a follow-up because the engine
 * already bumps file-size-aware buckets via `RemoteFile.size`.
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

import { normalizeRemoteRelPath } from "../core";
import { type MicrosoftAccount, getAccessToken } from "./auth";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GraphDriveItem {
  id: string;
  name: string;
  size?: number;
  eTag?: string;
  cTag?: string;
  lastModifiedDateTime?: string;
  file?: { mimeType?: string };
  folder?: { childCount?: number };
  deleted?: { state?: string };
  parentReference?: { path?: string; id?: string };
}

interface GraphPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

export function createOneDriveProvider(account: MicrosoftAccount): CloudFsProvider {
  const auth = async (): Promise<Record<string, string>> => ({
    Authorization: `Bearer ${await getAccessToken(account.accountId)}`,
  });

  const get = async <T>(url: string): Promise<T> => {
    const res = await httpRequest({
      method: "GET",
      url,
      headers: { ...(await auth()), Accept: "application/json" },
    });
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`OneDrive GET ${url} failed (status ${res.status}): ${res.body}`);
    }
    return JSON.parse(res.body) as T;
  };

  return {
    id: `onedrive:${account.accountId}`,
    category: "cloud",
    displayName: `OneDrive (${account.displayName})`,

    async status(): Promise<ProviderStatus> {
      try {
        await getAccessToken(account.accountId);
        return "ready";
      } catch {
        return "unconfigured";
      }
    },

    async listRoots(): Promise<RemoteFolder[]> {
      const page = await get<GraphPage<GraphDriveItem>>(
        `${GRAPH}/me/drive/root/children`,
      );
      return page.value
        .filter((item) => Boolean(item.folder))
        .map((item) => ({ id: item.id, name: item.name }));
    },

    async enumerateFiles(rootId: string): Promise<{ files: RemoteFile[]; cursor: string }> {
      // Graph's delta endpoint doubles as a recursive enumerator on the
      // initial call. Subsequent passes use the returned deltaLink as
      // the cursor, so the engine converges on incremental updates.
      const files: RemoteFile[] = [];
      const rootPathPrefix = await resolveRootPathPrefix(get, rootId);
      let cursor = "";
      let url = `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}/delta`;
      while (url) {
        const page = await get<GraphPage<GraphDriveItem>>(url);
        for (const item of page.value) {
          if (!item.file || item.deleted) continue;
          const file = toRemoteFile(item, rootPathPrefix);
          if (file) files.push(file);
        }
        if (page["@odata.nextLink"]) {
          url = page["@odata.nextLink"];
        } else {
          cursor = page["@odata.deltaLink"] ?? "";
          break;
        }
      }
      return { files, cursor };
    },

    async delta(rootId: string, cursor: string | undefined): Promise<DeltaResult> {
      const rootPathPrefix = await resolveRootPathPrefix(get, rootId);
      const url =
        cursor ||
        `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}/delta`;
      const page = await get<GraphPage<GraphDriveItem>>(url);

      const changes: DeltaChange[] = [];
      for (const item of page.value) {
        if (item.deleted) {
          const relPath = relPathFor(item, rootPathPrefix);
          if (relPath !== null) changes.push({ kind: "removed", relPath, id: item.id });
        } else if (item.file) {
          const file = toRemoteFile(item, rootPathPrefix);
          if (file) changes.push({ kind: "modified", file });
        }
        // Folder items themselves don't drive sync; their file children do.
      }

      // Graph returns `nextLink` while paging the delta and `deltaLink`
      // once exhausted. Surface that to the engine: if we got
      // `nextLink`, more pages remain and the engine should drain.
      const nextCursor = page["@odata.deltaLink"] ?? page["@odata.nextLink"] ?? cursor ?? "";
      const hasMore = Boolean(page["@odata.nextLink"]);
      return { changes, nextCursor, hasMore };
    },

    async downloadFile(file: RemoteFile, destAbsPath: string): Promise<void> {
      const res = await httpRequestBytes({
        method: "GET",
        url: `${GRAPH}/me/drive/items/${encodeURIComponent(file.id)}/content`,
        headers: { ...(await auth()) },
      });
      if (res.status < 200 || res.status >= 300) {
        const text = new TextDecoder().decode(res.body);
        throw new Error(`OneDrive download failed (status ${res.status}): ${text}`);
      }
      await writeFile(destAbsPath, res.body);
    },

    async uploadFile(rootId, relPath, sourceAbsPath): Promise<RemoteFile> {
      const bytes = await readFile(sourceAbsPath);
      // Graph's simple-upload path is `/items/{parent-id}:/{relPath}:/content`.
      // The id-then-path notation keeps the upload anchored to the root
      // even if the user renamed intermediate folders.
      const encodedPath = relPath
        .split("/")
        .map((seg) => encodeURIComponent(seg))
        .join("/");
      const url = `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}:/${encodedPath}:/content`;
      const res = await httpRequestBytes({
        method: "PUT",
        url,
        headers: {
          ...(await auth()),
          "Content-Type": "application/octet-stream",
        },
        body: bytes,
      });
      if (res.status < 200 || res.status >= 300) {
        const text = new TextDecoder().decode(res.body);
        throw new Error(`OneDrive upload failed (status ${res.status}): ${text}`);
      }
      const rootPathPrefix = await resolveRootPathPrefix(get, rootId);
      const metadata = JSON.parse(new TextDecoder().decode(res.body)) as GraphDriveItem;
      return toRemoteFile(metadata, rootPathPrefix) ?? {
        id: metadata.id,
        relPath,
        rev: metadata.eTag ?? metadata.cTag,
        size: metadata.size,
        modifiedAt: metadata.lastModifiedDateTime,
      };
    },

    async deleteRemoteFile(_rootId, file): Promise<void> {
      const res = await httpRequest({
        method: "DELETE",
        url: `${GRAPH}/me/drive/items/${encodeURIComponent(file.id)}`,
        headers: { ...(await auth()) },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`OneDrive delete failed (status ${res.status})`);
      }
    },
  };
}

async function resolveRootPathPrefix(
  get: <T>(url: string) => Promise<T>,
  rootId: string,
): Promise<string> {
  const root = await get<GraphDriveItem>(
    `${GRAPH}/me/drive/items/${encodeURIComponent(rootId)}?$select=id,name,parentReference`,
  );
  return itemAbsolutePath(root) ?? root.name;
}

function toRemoteFile(item: GraphDriveItem, rootPathPrefix: string): RemoteFile | null {
  const relPath = relPathFor(item, rootPathPrefix);
  if (!relPath) return null;
  return {
    id: item.id,
    relPath,
    rev: item.eTag ?? item.cTag,
    size: item.size,
    modifiedAt: item.lastModifiedDateTime,
  };
}

/**
 * Compute the project-relative path from the item's parent reference.
 * Graph returns paths like `/drive/root:/Typeward/proj1/sub/foo` and the
 * file's name separately. We resolve the chosen root folder once, then
 * strip exactly that prefix from children and deltas.
 */
function relPathFor(item: GraphDriveItem, rootPathPrefix: string): string | null {
  const absolute = itemAbsolutePath(item);
  if (!absolute) return null;
  const root = trimSlashes(rootPathPrefix);
  if (absolute === root) return null;
  if (!absolute.startsWith(`${root}/`)) return null;
  const rel = absolute.slice(root.length + 1);
  try {
    return normalizeRemoteRelPath(rel);
  } catch {
    return null;
  }
}

function itemAbsolutePath(item: GraphDriveItem): string | null {
  if (!item.name) return null;
  const parentPath = trimSlashes(stripDriveRootPrefix(item.parentReference?.path ?? ""));
  return parentPath ? `${parentPath}/${item.name}` : item.name;
}

function stripDriveRootPrefix(path: string): string {
  return path.replace(/^\/drive\/root:?\/?/, "");
}

function trimSlashes(path: string): string {
  return path.replace(/[\\/]+/g, "/").replace(/^\/+|\/+$/g, "");
}
