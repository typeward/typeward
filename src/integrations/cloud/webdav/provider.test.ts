import { afterEach, describe, expect, it, vi } from "vitest";

// WebDAV transport (PROPFIND / GET / PUT / DELETE / status) lives in Rust behind
// ./ipc; the fs plugin only stages download/upload bytes. Stub both so the
// poll-and-diff delta, revOf fallback, and two-path-space bridge run headlessly.
vi.mock("@tauri-apps/plugin-fs", () => ({
  readFile: vi.fn(async () => new TextEncoder().encode("local bytes")),
  writeFile: vi.fn(async () => {}),
}));

vi.mock("./ipc", () => ({
  webdavPropfind: vi.fn(),
  webdavGet: vi.fn(),
  webdavPut: vi.fn(),
  webdavDelete: vi.fn(),
  webdavStatusProbe: vi.fn(),
}));

import { readFile, writeFile } from "@tauri-apps/plugin-fs";

import {
  webdavDelete,
  webdavGet,
  webdavPropfind,
  webdavPut,
  webdavStatusProbe,
  type WebdavAccount,
  type WebdavEntry,
} from "./ipc";
import { createWebdavProvider } from "./provider";
import { normalizeRemoteRelPath } from "../core/paths";

const ACCOUNT: WebdavAccount = {
  accountId: "acc-1",
  baseUrl: "https://dav.example.com/remote.php/dav/files/user/",
  username: "user",
  allowPrivateHost: false,
};

function dir(relPath: string): WebdavEntry {
  return { relPath, isDir: true };
}

function file(
  relPath: string,
  extra: Partial<Pick<WebdavEntry, "etag" | "size" | "lastModified">> = {},
): WebdavEntry {
  return { relPath, isDir: false, etag: extra.etag, size: extra.size, lastModified: extra.lastModified };
}

/** Build a PROPFIND mock that resolves each directory to its listed entries.
 * `webdavPropfind(account, dir, depth)` — key on the dir argument. */
function propfindFrom(tree: Record<string, WebdavEntry[]>) {
  vi.mocked(webdavPropfind).mockImplementation(async (_acc, relPath: string) => ({
    entries: tree[relPath] ?? [],
  }));
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("createWebdavProvider status", () => {
  it("is ready when the probe succeeds", async () => {
    vi.mocked(webdavStatusProbe).mockResolvedValueOnce(true);
    expect(await createWebdavProvider(ACCOUNT).status()).toBe("ready");
  });

  it("is error when the probe fails or rejects", async () => {
    vi.mocked(webdavStatusProbe).mockResolvedValueOnce(false);
    expect(await createWebdavProvider(ACCOUNT).status()).toBe("error");
    vi.mocked(webdavStatusProbe).mockRejectedValueOnce(new Error("net"));
    expect(await createWebdavProvider(ACCOUNT).status()).toBe("error");
  });
});

describe("createWebdavProvider listRoots", () => {
  it("returns only directories at the base", async () => {
    propfindFrom({ "": [dir("Paper"), dir("Notes"), file("readme.md", { etag: "e" })] });
    const roots = await createWebdavProvider(ACCOUNT).listRoots();
    expect(roots).toEqual([
      { id: "Paper", name: "Paper" },
      { id: "Notes", name: "Notes" },
    ]);
  });
});

describe("createWebdavProvider enumerateFiles", () => {
  it("BFS-walks the subtree and strips the rootId prefix from relPaths", async () => {
    propfindFrom({
      "projects/paper": [
        file("projects/paper/main.tex", { etag: "e1", size: 10, lastModified: "t1" }),
        dir("projects/paper/sections"),
      ],
      "projects/paper/sections": [
        file("projects/paper/sections/intro.tex", { etag: "e2", size: 5, lastModified: "t2" }),
      ],
    });

    const { files, cursor } = await createWebdavProvider(ACCOUNT).enumerateFiles("projects/paper");

    // ids stay base-relative (what the Rust IPCs take); relPath is root-relative.
    expect(files).toEqual([
      { id: "projects/paper/main.tex", relPath: "main.tex", rev: "e1", size: 10, modifiedAt: "t1" },
      {
        id: "projects/paper/sections/intro.tex",
        relPath: "sections/intro.tex",
        rev: "e2",
        size: 5,
        modifiedAt: "t2",
      },
    ]);

    // The cursor is a serialized snapshot keyed by base-relative id.
    expect(JSON.parse(cursor)).toEqual({
      v: 1,
      snap: {
        "projects/paper/main.tex": "e1",
        "projects/paper/sections/intro.tex": "e2",
      },
    });
  });

  it("falls back to size+mtime for the rev when the server omits getetag", async () => {
    propfindFrom({ "": [file("a.tex", { size: 7, lastModified: "2026-01-01" })] });
    const { files } = await createWebdavProvider(ACCOUNT).enumerateFiles("");
    expect(files[0].rev).toBe("s:7:m:2026-01-01");
  });
});

describe("createWebdavProvider delta (poll-and-diff)", () => {
  it("derives added/modified/removed across two polls", async () => {
    const provider = createWebdavProvider(ACCOUNT);

    // Poll 1: initial snapshot, everything is "added".
    propfindFrom({
      "": [file("keep.tex", { etag: "k1" }), file("drop.tex", { etag: "d1" }), dir("sub")],
      sub: [file("sub/edit.tex", { etag: "s1" })],
    });
    const first = await provider.delta("", undefined);
    expect(first.changes.map((c) => c.kind).sort()).toEqual(["added", "added", "added"]);

    // Poll 2: keep unchanged, drop removed, edit changed, brand-new added.
    propfindFrom({
      "": [file("keep.tex", { etag: "k1" }), file("new.tex", { etag: "n1" }), dir("sub")],
      sub: [file("sub/edit.tex", { etag: "s2" })],
    });
    const second = await provider.delta("", first.nextCursor);

    const byKind = (k: string) => second.changes.filter((c) => c.kind === k);
    expect(byKind("added")).toEqual([
      { kind: "added", file: expect.objectContaining({ relPath: "new.tex", rev: "n1" }) },
    ]);
    expect(byKind("modified")).toEqual([
      { kind: "modified", file: expect.objectContaining({ relPath: "sub/edit.tex", rev: "s2" }) },
    ]);
    expect(byKind("removed")).toEqual([{ kind: "removed", relPath: "drop.tex" }]);

    // keep.tex (unchanged etag) produces no change.
    expect(second.changes.some((c) => "file" in c && c.file.relPath === "keep.tex")).toBe(false);
  });

  it("detects an etag-less content change via the size+mtime rev fallback", async () => {
    const provider = createWebdavProvider(ACCOUNT);
    propfindFrom({ "": [file("a.tex", { size: 5, lastModified: "t1" })] });
    const first = await provider.delta("", undefined);
    expect(first.changes).toHaveLength(1);

    propfindFrom({ "": [file("a.tex", { size: 9, lastModified: "t2" })] });
    const second = await provider.delta("", first.nextCursor);
    expect(second.changes).toEqual([
      { kind: "modified", file: expect.objectContaining({ relPath: "a.tex", rev: "s:9:m:t2" }) },
    ]);
  });

  it("strips the rootId prefix from delta relPaths for a non-empty root", async () => {
    propfindFrom({ docs: [file("docs/paper.tex", { etag: "e1" })] });
    const first = await createWebdavProvider(ACCOUNT).delta("docs", undefined);
    expect(first.changes).toEqual([
      { kind: "added", file: expect.objectContaining({ id: "docs/paper.tex", relPath: "paper.tex" }) },
    ]);
  });
});

describe("createWebdavProvider download/upload round-trip", () => {
  it("downloads via the base-relative id and writes to the destination", async () => {
    const bytes = new TextEncoder().encode("BODY");
    vi.mocked(webdavGet).mockResolvedValueOnce({ etag: "e", body: bytes });

    await createWebdavProvider(ACCOUNT).downloadFile(
      { id: "projects/paper/main.tex", relPath: "main.tex", rev: "e" },
      "/cache/main.tex",
    );

    expect(webdavGet).toHaveBeenCalledWith(ACCOUNT, "projects/paper/main.tex");
    expect(writeFile).toHaveBeenCalledWith("/cache/main.tex", bytes);
  });

  it("joins the relPath back under the rootId and returns the base-relative id", async () => {
    const bytes = new TextEncoder().encode("hello");
    vi.mocked(readFile).mockResolvedValueOnce(bytes);
    vi.mocked(webdavPut).mockResolvedValueOnce({ etag: "up-etag" });

    const meta = await createWebdavProvider(ACCOUNT).uploadFile(
      "projects/paper",
      "sections/intro.tex",
      "/cache/sections/intro.tex",
    );

    expect(readFile).toHaveBeenCalledWith("/cache/sections/intro.tex");
    // joinUnderBase: rootId + relPath -> base-relative id used by the Rust IPC.
    expect(webdavPut).toHaveBeenCalledWith(ACCOUNT, "projects/paper/sections/intro.tex", bytes);
    expect(meta).toEqual({
      id: "projects/paper/sections/intro.tex",
      relPath: "sections/intro.tex",
      rev: "up-etag",
      size: bytes.length,
    });
  });
});

describe("createWebdavProvider deleteRemoteFile", () => {
  it("deletes by the base-relative id", async () => {
    vi.mocked(webdavDelete).mockResolvedValueOnce(undefined);
    await createWebdavProvider(ACCOUNT).deleteRemoteFile("projects/paper", {
      id: "projects/paper/old.tex",
      relPath: "old.tex",
      rev: "e",
    });
    expect(webdavDelete).toHaveBeenCalledWith(ACCOUNT, "projects/paper/old.tex");
  });
});

describe("provider output at the engine normalization boundary", () => {
  it("a remote file inside .typeward is rejected by normalizeRemoteRelPath", async () => {
    propfindFrom({ "": [dir(".typeward"), file(".typeward/cursor", { etag: "e" })] });
    const { files } = await createWebdavProvider(ACCOUNT).enumerateFiles("");
    expect(files[0].relPath).toBe(".typeward/cursor");
    expect(() => normalizeRemoteRelPath(files[0].relPath)).toThrow(/internal state/);
  });
});
