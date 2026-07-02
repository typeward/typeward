import { afterEach, describe, expect, it, vi } from "vitest";

// The provider talks to Dropbox only through ~/integrations/http and writes
// downloaded bytes / reads upload bytes through the fs plugin. Stub both so the
// listing/delta/casing/round-trip logic runs headlessly with no network or disk.
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(async () => new TextEncoder().encode("local bytes")),
  writeFile: vi.fn(async () => {}),
}));

// ./auth reads import.meta.env.VITE_DROPBOX_CLIENT_ID inside dropboxAuthRef();
// stub it so tests don't depend on env and we can flip hasDropboxTokens.
vi.mock("./auth", () => ({
  dropboxAuthRef: vi.fn((accountId: string) => ({
    service: "dropbox",
    account: accountId,
    header: "Authorization",
    prefix: "Bearer ",
    clientId: "test-client",
  })),
  hasDropboxTokens: vi.fn(async () => true),
}));

vi.mock("~/integrations/http", () => ({
  httpRequest: vi.fn(),
  httpRequestBytes: vi.fn(),
}));

import { readFile, writeFile } from "@tauri-apps/plugin-fs";

import { httpRequest, httpRequestBytes } from "~/integrations/http";

import { hasDropboxTokens } from "./auth";
import { createDropboxProvider, type DropboxAccount } from "./provider";
import { normalizeRemoteRelPath } from "../core/paths";

const ACCOUNT: DropboxAccount = {
  accountId: "acc-1",
  email: "user@example.com",
  displayName: "User",
};

const ROOT = "/remote/root";

function jsonRes(body: unknown, status = 200) {
  return { status, headers: {}, body: JSON.stringify(body) };
}

function jsonBytes(body: unknown, status = 200) {
  return { status, headers: {}, body: new TextEncoder().encode(JSON.stringify(body)) };
}

function fileEntry(pathLower: string, pathDisplay: string, rev: string, size = 3) {
  return {
    ".tag": "file" as const,
    id: `id:${pathLower}`,
    name: pathLower.split("/").pop() ?? "",
    path_display: pathDisplay,
    path_lower: pathLower,
    rev,
    size,
    server_modified: "2026-01-01T00:00:00Z",
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createDropboxProvider status", () => {
  it("is ready when a token bundle exists", async () => {
    vi.mocked(hasDropboxTokens).mockResolvedValueOnce(true);
    const provider = createDropboxProvider(ACCOUNT);
    expect(await provider.status()).toBe("ready");
  });

  it("is unconfigured when the token bundle is missing", async () => {
    vi.mocked(hasDropboxTokens).mockResolvedValueOnce(false);
    const provider = createDropboxProvider(ACCOUNT);
    expect(await provider.status()).toBe("unconfigured");
  });
});

describe("createDropboxProvider listRoots", () => {
  it("returns only folders, keyed by path_lower id", async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce(
      jsonRes({
        entries: [
          { ".tag": "folder", id: "id:1", name: "Paper", path_display: "/Paper", path_lower: "/paper" },
          fileEntry("/readme.md", "/readme.md", "r1"),
        ],
        cursor: "c0",
        has_more: false,
      }),
    );
    const provider = createDropboxProvider(ACCOUNT);
    const roots = await provider.listRoots();
    expect(roots).toEqual([{ id: "/paper", name: "Paper" }]);
  });
});

describe("createDropboxProvider enumerateFiles", () => {
  it("paginates via list_folder/continue and preserves original path casing", async () => {
    vi.mocked(httpRequest)
      .mockResolvedValueOnce(
        jsonRes({
          entries: [
            fileEntry(`${ROOT}/main.tex`, `${ROOT}/main.tex`, "rev-a"),
            { ".tag": "folder", id: "id:f", name: "Figures", path_display: `${ROOT}/Figures`, path_lower: `${ROOT}/figures` },
          ],
          cursor: "c1",
          has_more: true,
        }),
      )
      .mockResolvedValueOnce(
        jsonRes({
          entries: [fileEntry(`${ROOT}/figures/plot.png`, `${ROOT}/Figures/Plot.PNG`, "rev-b", 42)],
          cursor: "c2",
          has_more: false,
        }),
      );

    const provider = createDropboxProvider(ACCOUNT);
    const { files, cursor } = await provider.enumerateFiles(ROOT);

    // Folder entries are dropped; the recursive page 2 is walked.
    expect(files).toHaveLength(2);
    expect(cursor).toBe("c2");

    const main = files.find((f) => f.relPath === "main.tex");
    expect(main).toMatchObject({ id: `${ROOT}/main.tex`, rev: "rev-a" });

    // path_lower is the id (stable), path_display drives the cache relPath so
    // case-sensitive \includegraphics paths survive (the 2026-06-14 fix).
    const plot = files.find((f) => f.id === `${ROOT}/figures/plot.png`);
    expect(plot).toMatchObject({ relPath: "Figures/Plot.PNG", rev: "rev-b", size: 42 });

    // Second page came from list_folder/continue with the previous cursor.
    const secondCall = vi.mocked(httpRequest).mock.calls[1][0];
    expect(secondCall.url).toContain("/2/files/list_folder/continue");
    expect(JSON.parse(secondCall.body as string)).toEqual({ cursor: "c1" });
  });

  it("throws on a non-2xx list response", async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce({ status: 401, headers: {}, body: "no auth" });
    const provider = createDropboxProvider(ACCOUNT);
    await expect(provider.enumerateFiles(ROOT)).rejects.toThrow(/status 401/);
  });
});

describe("createDropboxProvider delta", () => {
  it("maps file entries to modified and deleted entries to removed with original casing", async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce(
      jsonRes({
        entries: [
          fileEntry(`${ROOT}/main.tex`, `${ROOT}/main.tex`, "rev-2"),
          {
            ".tag": "deleted",
            name: "Old.PNG",
            path_display: `${ROOT}/Figures/Old.PNG`,
            path_lower: `${ROOT}/figures/old.png`,
          },
          // Folder entries never drive sync.
          { ".tag": "folder", id: "id:f2", name: "Sub", path_display: `${ROOT}/Sub`, path_lower: `${ROOT}/sub` },
        ],
        cursor: "c-next",
        has_more: false,
      }),
    );

    const provider = createDropboxProvider(ACCOUNT);
    const result = await provider.delta(ROOT, "c-prev");

    expect(result.nextCursor).toBe("c-next");
    expect(result.changes).toEqual([
      { kind: "modified", file: expect.objectContaining({ relPath: "main.tex", rev: "rev-2" }) },
      { kind: "removed", relPath: "Figures/Old.PNG" },
    ]);

    // A cursor present means the continue endpoint is used.
    const call = vi.mocked(httpRequest).mock.calls[0][0];
    expect(call.url).toContain("/2/files/list_folder/continue");
    expect(JSON.parse(call.body as string)).toEqual({ cursor: "c-prev" });
  });

  it("uses list_folder (not continue) on the first delta with no cursor", async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce(
      jsonRes({ entries: [], cursor: "c0", has_more: false }),
    );
    const provider = createDropboxProvider(ACCOUNT);
    await provider.delta(ROOT, undefined);
    const call = vi.mocked(httpRequest).mock.calls[0][0];
    expect(call.url).toContain("/2/files/list_folder");
    expect(call.url).not.toContain("continue");
    expect(JSON.parse(call.body as string)).toMatchObject({
      path: ROOT,
      recursive: true,
      include_deleted: true,
    });
  });
});

describe("createDropboxProvider download/upload round-trip", () => {
  it("downloads bytes into the destination via the Dropbox-API-Arg header", async () => {
    const bytes = new TextEncoder().encode("PDF-BYTES");
    vi.mocked(httpRequestBytes).mockResolvedValueOnce({ status: 200, headers: {}, body: bytes });

    const provider = createDropboxProvider(ACCOUNT);
    await provider.downloadFile(
      { id: `${ROOT}/main.tex`, relPath: "main.tex", rev: "r" },
      "/cache/main.tex",
    );

    const call = vi.mocked(httpRequestBytes).mock.calls[0][0];
    expect(call.url).toContain("/2/files/download");
    expect(JSON.parse(call.headers?.["Dropbox-API-Arg"] as string)).toEqual({
      path: `${ROOT}/main.tex`,
    });
    expect(writeFile).toHaveBeenCalledWith("/cache/main.tex", bytes);
  });

  it("uploads source bytes to the joined remote path and returns metadata", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(new TextEncoder().encode("hello"));
    vi.mocked(httpRequestBytes).mockResolvedValueOnce(
      jsonBytes(fileEntry(`${ROOT}/sections/intro.tex`, `${ROOT}/sections/intro.tex`, "rev-up", 5)),
    );

    const provider = createDropboxProvider(ACCOUNT);
    const meta = await provider.uploadFile(ROOT, "sections/intro.tex", "/cache/sections/intro.tex");

    expect(readFile).toHaveBeenCalledWith("/cache/sections/intro.tex");
    const call = vi.mocked(httpRequestBytes).mock.calls[0][0];
    expect(call.url).toContain("/2/files/upload");
    expect(JSON.parse(call.headers?.["Dropbox-API-Arg"] as string)).toMatchObject({
      path: `${ROOT}/sections/intro.tex`,
      mode: "overwrite",
    });
    expect(meta).toMatchObject({
      id: `${ROOT}/sections/intro.tex`,
      relPath: "sections/intro.tex",
      rev: "rev-up",
    });
  });

  it("throws on a non-2xx upload", async () => {
    vi.mocked(readFile).mockResolvedValueOnce(new TextEncoder().encode("x"));
    vi.mocked(httpRequestBytes).mockResolvedValueOnce({
      status: 409,
      headers: {},
      body: new TextEncoder().encode("conflict"),
    });
    const provider = createDropboxProvider(ACCOUNT);
    await expect(provider.uploadFile(ROOT, "a.tex", "/cache/a.tex")).rejects.toThrow(/status 409/);
  });
});

describe("createDropboxProvider deleteRemoteFile", () => {
  it("calls delete_v2 with the path id", async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce(jsonRes({ metadata: {} }));
    const provider = createDropboxProvider(ACCOUNT);
    await provider.deleteRemoteFile(ROOT, { id: `${ROOT}/gone.tex`, relPath: "gone.tex", rev: "r" });
    const call = vi.mocked(httpRequest).mock.calls[0][0];
    expect(call.url).toContain("/2/files/delete_v2");
    expect(JSON.parse(call.body as string)).toEqual({ path: `${ROOT}/gone.tex` });
  });
});

describe("provider output at the engine normalization boundary", () => {
  it("a remote file inside .typeward is rejected by normalizeRemoteRelPath", async () => {
    vi.mocked(httpRequest).mockResolvedValueOnce(
      jsonRes({
        entries: [fileEntry(`${ROOT}/.typeward/snapshots/x.snap`, `${ROOT}/.typeward/snapshots/x.snap`, "r")],
        cursor: "c",
        has_more: false,
      }),
    );
    const provider = createDropboxProvider(ACCOUNT);
    const { files } = await provider.enumerateFiles(ROOT);
    // The provider passes the raw relPath through; the engine guard is the gate.
    expect(files[0].relPath).toBe(".typeward/snapshots/x.snap");
    expect(() => normalizeRemoteRelPath(files[0].relPath)).toThrow(/internal state/);
  });
});
