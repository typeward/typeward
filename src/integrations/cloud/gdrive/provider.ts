/**
 * Google Drive CloudFsProvider.
 *
 * The `drive.file` scope (per-app, privacy-friendly) means we only see
 * files/folders the user has created or opened with Typeward. Picking
 * an existing arbitrary Drive folder doesn't work under this scope —
 * the user picks the root via the Google Picker when creating a new
 * project, and from then on the app has access to everything beneath.
 *
 * Paths are derived via an id↔path map kept beside the sync cursor.
 * Drive's `changes.list` API returns file diffs by id; we keep the map
 * fresh by re-resolving any unseen id by walking its parent chain at
 * the time of the change.
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

import { type GoogleAccount, getAccessToken } from "./auth";
import { type IdMap, emptyIdMap, loadIdMap, saveIdMap } from "./idmap";

const API = "https://www.googleapis.com/drive/v3";
const UPLOAD = "https://www.googleapis.com/upload/drive/v3";
const FOLDER_MIME = "application/vnd.google-apps.folder";
const FILE_FIELDS =
  "id,name,mimeType,parents,modifiedTime,size,trashed,md5Checksum";

interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents?: string[];
  modifiedTime?: string;
  size?: string;
  trashed?: boolean;
  md5Checksum?: string;
}

interface DriveFileList {
  files: DriveFile[];
  nextPageToken?: string;
}

interface DriveChange {
  fileId: string;
  removed?: boolean;
  file?: DriveFile;
}

interface DriveChangeList {
  changes: DriveChange[];
  nextPageToken?: string;
  newStartPageToken?: string;
}

export interface GoogleDriveProviderOptions {
  /** Where to persist the id↔path map. Engine knows the per-project path. */
  idMapPath: string;
}

export function createGoogleDriveProvider(
  account: GoogleAccount,
  options: GoogleDriveProviderOptions,
): CloudFsProvider {
  let cachedMap: IdMap | undefined;

  const map = async (): Promise<IdMap> => {
    if (!cachedMap) cachedMap = await loadIdMap(options.idMapPath);
    return cachedMap;
  };

  const flushMap = async (): Promise<void> => {
    if (cachedMap) await saveIdMap(options.idMapPath, cachedMap);
  };

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
      throw new Error(`Drive GET ${url} failed (status ${res.status}): ${res.body}`);
    }
    return JSON.parse(res.body) as T;
  };

  const resolveRelPath = async (
    file: DriveFile,
    rootId: string,
  ): Promise<string | null> => {
    const m = await map();
    if (file.parents?.includes(rootId)) {
      const rel = file.name;
      if (file.mimeType === FOLDER_MIME) m.folders[file.id] = rel;
      else m.files[file.id] = rel;
      return rel;
    }
    const parentId = file.parents?.[0];
    if (!parentId) return null;
    const parentRel = m.folders[parentId];
    if (parentRel !== undefined) {
      const rel = `${parentRel}/${file.name}`;
      if (file.mimeType === FOLDER_MIME) m.folders[file.id] = rel;
      else m.files[file.id] = rel;
      return rel;
    }
    // Need to fetch the parent and resolve its path first.
    const parentMeta = await get<DriveFile>(
      `${API}/files/${encodeURIComponent(parentId)}?fields=${encodeURIComponent(FILE_FIELDS)}`,
    );
    if (parentMeta.id === rootId) {
      m.folders[parentId] = "";
      const rel = file.name;
      if (file.mimeType === FOLDER_MIME) m.folders[file.id] = rel;
      else m.files[file.id] = rel;
      return rel;
    }
    const parentRelResolved = await resolveRelPath(parentMeta, rootId);
    if (parentRelResolved === null) return null;
    m.folders[parentId] = parentRelResolved;
    const rel = `${parentRelResolved}/${file.name}`;
    if (file.mimeType === FOLDER_MIME) m.folders[file.id] = rel;
    else m.files[file.id] = rel;
    return rel;
  };

  return {
    id: `gdrive:${account.accountId}`,
    category: "cloud",
    displayName: `Google Drive (${account.displayName})`,

    async status(): Promise<ProviderStatus> {
      try {
        await getAccessToken(account.accountId);
        return "ready";
      } catch {
        return "unconfigured";
      }
    },

    async listRoots(): Promise<RemoteFolder[]> {
      // Under `drive.file` scope, we can only see folders the app
      // created/opened. Surface those — typically the user has created
      // a few Typeward-hosted folders previously.
      const list = await get<DriveFileList>(
        `${API}/files?q=mimeType%3D'${encodeURIComponent(FOLDER_MIME)}'+and+trashed%3Dfalse&fields=${encodeURIComponent("files(id,name)")}&pageSize=100`,
      );
      return list.files.map((f) => ({ id: f.id, name: f.name }));
    },

    async enumerateFiles(rootId): Promise<{ files: RemoteFile[]; cursor: string }> {
      cachedMap = emptyIdMap();
      cachedMap.folders[rootId] = "";

      const files: RemoteFile[] = [];
      const queue: string[] = [rootId];
      while (queue.length > 0) {
        const parentId = queue.shift()!;
        let pageToken: string | undefined;
        while (true) {
          const q = `'${parentId}' in parents and trashed=false`;
          const url =
            `${API}/files?q=${encodeURIComponent(q)}` +
            `&fields=${encodeURIComponent(`nextPageToken,files(${FILE_FIELDS})`)}` +
            `&pageSize=1000` +
            (pageToken ? `&pageToken=${encodeURIComponent(pageToken)}` : "");
          const page = await get<DriveFileList>(url);
          for (const item of page.files) {
            const rel = await resolveRelPath(item, rootId);
            if (rel === null) continue;
            if (item.mimeType === FOLDER_MIME) {
              queue.push(item.id);
            } else {
              files.push(toRemoteFile(item, rel));
            }
          }
          if (!page.nextPageToken) break;
          pageToken = page.nextPageToken;
        }
      }

      const tokenRes = await get<{ startPageToken: string }>(
        `${API}/changes/startPageToken`,
      );
      await flushMap();
      return { files, cursor: tokenRes.startPageToken };
    },

    async delta(rootId, cursor): Promise<DeltaResult> {
      const startToken =
        cursor ??
        (await get<{ startPageToken: string }>(`${API}/changes/startPageToken`))
          .startPageToken;

      const url =
        `${API}/changes?pageToken=${encodeURIComponent(startToken)}` +
        `&fields=${encodeURIComponent(`nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`)}` +
        `&pageSize=1000` +
        `&includeRemoved=true`;
      const result = await get<DriveChangeList>(url);

      const changes: DeltaChange[] = [];
      const m = await map();
      for (const change of result.changes) {
        if (change.removed) {
          const relPath = m.files[change.fileId];
          if (relPath !== undefined) {
            changes.push({ kind: "removed", relPath, id: change.fileId });
            delete m.files[change.fileId];
          }
          continue;
        }
        const file = change.file;
        if (!file || file.trashed || file.mimeType === FOLDER_MIME) continue;
        const rel = await resolveRelPath(file, rootId);
        if (rel === null) continue;
        changes.push({ kind: "modified", file: toRemoteFile(file, rel) });
      }

      const nextCursor = result.newStartPageToken ?? result.nextPageToken ?? startToken;
      const hasMore = Boolean(result.nextPageToken);
      await flushMap();
      return { changes, nextCursor, hasMore };
    },

    async downloadFile(file, destAbsPath): Promise<void> {
      const res = await httpRequestBytes({
        method: "GET",
        url: `${API}/files/${encodeURIComponent(file.id)}?alt=media`,
        headers: { ...(await auth()) },
      });
      if (res.status < 200 || res.status >= 300) {
        const text = new TextDecoder().decode(res.body);
        throw new Error(`Drive download failed (status ${res.status}): ${text}`);
      }
      await writeFile(destAbsPath, res.body);
    },

    async uploadFile(rootId, relPath, sourceAbsPath): Promise<RemoteFile> {
      // Resolve / create the parent folder chain and the file's final
      // parent. The id↔path map shortcuts most lookups.
      const parentId = await ensureFolderChain(this, rootId, relPath, map);
      const name = relPath.split("/").pop() ?? relPath;

      const m = await map();
      const existingId = lookupFileId(m, relPath);
      const bytes = await readFile(sourceAbsPath);

      let url: string;
      let method: "POST" | "PATCH";
      if (existingId) {
        url = `${UPLOAD}/files/${encodeURIComponent(existingId)}?uploadType=media`;
        method = "PATCH";
      } else {
        // Two-step: create metadata then upload bytes. Simpler than
        // multipart for binary uploads via our IPC.
        const metaRes = await httpRequest({
          method: "POST",
          url: `${API}/files?fields=${encodeURIComponent(FILE_FIELDS)}`,
          headers: { ...(await auth()), "Content-Type": "application/json" },
          body: JSON.stringify({ name, parents: [parentId] }),
        });
        if (metaRes.status < 200 || metaRes.status >= 300) {
          throw new Error(`Drive metadata create failed (status ${metaRes.status}): ${metaRes.body}`);
        }
        const created = JSON.parse(metaRes.body) as DriveFile;
        url = `${UPLOAD}/files/${encodeURIComponent(created.id)}?uploadType=media`;
        method = "PATCH";
      }

      const uploadRes = await httpRequestBytes({
        method,
        url: `${url}&fields=${encodeURIComponent(FILE_FIELDS)}`,
        headers: { ...(await auth()), "Content-Type": "application/octet-stream" },
        body: bytes,
      });
      if (uploadRes.status < 200 || uploadRes.status >= 300) {
        const text = new TextDecoder().decode(uploadRes.body);
        throw new Error(`Drive upload failed (status ${uploadRes.status}): ${text}`);
      }
      const metadata = JSON.parse(new TextDecoder().decode(uploadRes.body)) as DriveFile;
      m.files[metadata.id] = relPath;
      await flushMap();
      return toRemoteFile(metadata, relPath);
    },

    async deleteRemoteFile(_rootId, file): Promise<void> {
      const res = await httpRequest({
        method: "DELETE",
        url: `${API}/files/${encodeURIComponent(file.id)}`,
        headers: { ...(await auth()) },
      });
      if (res.status < 200 || res.status >= 300) {
        throw new Error(`Drive delete failed (status ${res.status})`);
      }
      const m = await map();
      delete m.files[file.id];
      await flushMap();
    },
  };
}

async function ensureFolderChain(
  provider: CloudFsProvider,
  rootId: string,
  relPath: string,
  map: () => Promise<IdMap>,
): Promise<string> {
  void provider;
  void rootId;
  // For Phase 2.4 MVP: only support files directly under the root, OR
  // files whose parent folder already exists in the id↔path map (created
  // by a prior pull/enumerate). Auto-creating folder chains on push is a
  // follow-up — most cloud-sync regressions come from racing folder
  // creation, and we'd rather fail loudly than silently misroute.
  const parts = relPath.split("/");
  if (parts.length === 1) return rootId;
  const parentRel = parts.slice(0, -1).join("/");
  const m = await map();
  for (const [folderId, folderPath] of Object.entries(m.folders)) {
    if (folderPath === parentRel) return folderId;
  }
  throw new Error(
    `Google Drive upload requires existing parent folder for '${relPath}'; auto-creating folder chains lands in a later phase.`,
  );
}

function lookupFileId(map: IdMap, relPath: string): string | undefined {
  for (const [id, p] of Object.entries(map.files)) {
    if (p === relPath) return id;
  }
  return undefined;
}

function toRemoteFile(file: DriveFile, relPath: string): RemoteFile {
  return {
    id: file.id,
    relPath,
    rev: file.md5Checksum,
    size: file.size ? Number.parseInt(file.size, 10) : undefined,
    modifiedAt: file.modifiedTime,
  };
}
