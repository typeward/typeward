/// <reference types="node" />
import { readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ipcMock } from "~/test/ipc-mock";

/**
 * IPC command-name drift guard.
 *
 * Every Tauri command registered in `src-tauri/src/lib.rs`'s
 * `generate_handler![ ... ]` must be reachable from a frontend `invoke("...")`
 * call, and vice-versa. A command added on one side of the bridge without the
 * other rejects at runtime with Tauri's opaque unknown-command error and no
 * compile-time or test signal — this test turns that into a CI failure.
 *
 * SCOPE: this checks the *set of command name strings* only. Full struct-field
 * type drift (a Rust field renamed / added without its TS mirror in this file)
 * is NOT covered here — that needs codegen (tauri-specta) or golden-JSON
 * fixtures and is deliberately out of scope for this guard. See finding 11.
 *
 * The task frames the frontend side as "src/ipc/index.ts", but the wrapper
 * layer is intentionally spread across subsystems that `invoke` directly
 * (LSP `client.ts`, `watcher/client.ts`, `auth/credentials.ts`,
 * `auth/oauth-client.ts`, `integrations/http.ts`, `ai/stream.ts`,
 * `cloud/webdav/ipc.ts`). Scanning the whole `src/` tree is what actually
 * matches the intent — otherwise every non-index wrapper reads as a false
 * "missing frontend wrapper".
 */

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..");
const srcRoot = join(repoRoot, "src");
const libRsPath = join(repoRoot, "src-tauri", "src", "lib.rs");

/**
 * Commands legitimately present on only one side, with justification. Keep this
 * empty; an entry here is a documented exception, not a place to silence drift.
 */
const RUST_ONLY_ALLOWLIST = new Set<string>([]);
const FRONTEND_ONLY_ALLOWLIST = new Set<string>([]);

function stripComments(src: string): string {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/\/\/[^\n]*/g, "");
}

function registeredRustCommands(): Set<string> {
  const src = readFileSync(libRsPath, "utf8");
  const start = src.indexOf("generate_handler![");
  expect(start, "generate_handler![ not found in lib.rs").toBeGreaterThanOrEqual(0);
  const open = src.indexOf("[", start);

  // Bracket-depth match: the block contains balanced `#[cfg(...)]` attributes,
  // so a naive first-`]` search would stop far too early.
  let depth = 0;
  let close = -1;
  for (let i = open; i < src.length; i++) {
    if (src[i] === "[") depth++;
    else if (src[i] === "]" && --depth === 0) {
      close = i;
      break;
    }
  }
  expect(close, "unterminated generate_handler! block").toBeGreaterThan(open);

  const block = stripComments(src.slice(open + 1, close));
  const names = new Set<string>();
  for (let chunk of block.split(",")) {
    // Drop any attributes like `#[cfg(desktop)]` attached to this entry.
    chunk = chunk.replace(/#\[[^\]]*\]/g, "").trim();
    if (!chunk) continue;
    const segments = chunk.split("::");
    const name = segments[segments.length - 1].trim();
    if (/^[a-z_][a-z0-9_]*$/.test(name)) names.add(name);
  }
  return names;
}

const INVOKE_RE = /invoke\s*(?:<[^>]*>)?\s*\(\s*["'`]([a-z_][a-z0-9_]*)["'`]/g;

function walkSourceFiles(dir: string, out: string[] = []): string[] {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      walkSourceFiles(full, out);
    } else if (/\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

function invokedFrontendCommands(): Set<string> {
  const names = new Set<string>();
  for (const file of walkSourceFiles(srcRoot)) {
    const src = stripComments(readFileSync(file, "utf8"));
    for (const match of src.matchAll(INVOKE_RE)) {
      names.add(match[1]);
    }
  }
  return names;
}

describe("IPC command drift guard", () => {
  const rust = registeredRustCommands();
  const frontend = invokedFrontendCommands();

  it("parses a plausible command set from both sides", () => {
    // Sanity floor: if parsing broke, don't let two empty sets look 'in sync'.
    expect(rust.size).toBeGreaterThan(30);
    expect(frontend.size).toBeGreaterThan(30);
  });

  it("has a frontend invoke() for every registered Rust command", () => {
    const missing = [...rust]
      .filter((cmd) => !frontend.has(cmd) && !RUST_ONLY_ALLOWLIST.has(cmd))
      .sort();
    expect(missing, "Rust commands with no frontend invoke() caller").toEqual([]);
  });

  it("has a registered Rust command for every frontend invoke()", () => {
    const missing = [...frontend]
      .filter((cmd) => !rust.has(cmd) && !FRONTEND_ONLY_ALLOWLIST.has(cmd))
      .sort();
    expect(missing, "frontend invoke() targets not registered in lib.rs").toEqual([]);
  });
});

describe("ipcMock helper", () => {
  it("returns provided overrides", async () => {
    const readProjectTextFile = async () => "hello";
    const mod = ipcMock({ readProjectTextFile });
    expect(mod.readProjectTextFile).toBe(readProjectTextFile);
    expect(await mod.readProjectTextFile("/p", "a.tex")).toBe("hello");
  });

  it("throws a descriptive error when an un-stubbed wrapper is called", () => {
    const mod = ipcMock();
    expect(() => mod.loadSettings()).toThrow(/loadSettings.*not stubbed/);
  });

  it("does not masquerade as a thenable", () => {
    const mod = ipcMock() as unknown as { then?: unknown };
    expect(mod.then).toBeUndefined();
  });
});
