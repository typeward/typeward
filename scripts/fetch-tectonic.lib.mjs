// Pure, side-effect-free supply-chain guards for fetch-tectonic.mjs.
//
// Split out of the CLI entry so the test suite can import these without Vitest's
// Rolldown SSR transform choking on the entry's `#!/usr/bin/env node` shebang:
// the transform hoists injected CJS import shims to byte 0, which pushes the
// shebang mid-line, and a `#!` sequence that is not at 1:1 is a parse error.
// This module has no shebang and no import-time side effects, so it transforms
// cleanly and keeps the digest-pinning + host-allowlist regression guards live.

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

export const TECTONIC_VERSION = "0.15.0";

// Release assets are served from github.com and redirect to GitHub's asset
// CDN. A redirect to anything else is an attack, not a mirror.
export const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
export const MAX_REDIRECTS = 5;

export const PLATFORMS = {
  // node platform/arch → { triple, archive, ext, exe, archiveSha256, exeSha256 }
  // archiveSha256: the published release asset. exeSha256: the binary inside
  // it, which is what actually lands in src-tauri/binaries (and what the
  // already-present-file check re-verifies).
  "win32:x64": {
    triple: "x86_64-pc-windows-msvc",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`,
    ext: "zip",
    exe: "tectonic.exe",
    archiveSha256: "1d6bb76f049c8a3774f6e9d66e4b04e1a8c3dcb37527b6b41b7e894328e7bf29",
    exeSha256: "6760c6368d3219c687eb1811e55379af9526fbd97e97fa954968267f5241deb9",
  },
  // No native Windows/arm64 Tectonic exists upstream — ship the x86_64 build
  // under the aarch64 triple name and let Windows-on-ARM emulation run it. See
  // the header note in fetch-tectonic.mjs. Same archive + digests as win32:x64.
  "win32:arm64": {
    triple: "aarch64-pc-windows-msvc",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`,
    ext: "zip",
    exe: "tectonic.exe",
    archiveSha256: "1d6bb76f049c8a3774f6e9d66e4b04e1a8c3dcb37527b6b41b7e894328e7bf29",
    exeSha256: "6760c6368d3219c687eb1811e55379af9526fbd97e97fa954968267f5241deb9",
  },
  "darwin:x64": {
    triple: "x86_64-apple-darwin",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-apple-darwin.tar.gz`,
    ext: "tar.gz",
    exe: "tectonic",
    archiveSha256: "dd42576eaa4c0df58c243dd78b7b864d9deb405ffdfcdadd1b79a31faceab747",
    exeSha256: "c53331a1c6e1a0bbc9a14bb7fa605ffbd2e379388df8d8b07c801642530b22cf",
  },
  "darwin:arm64": {
    triple: "aarch64-apple-darwin",
    archive: `tectonic-${TECTONIC_VERSION}-aarch64-apple-darwin.tar.gz`,
    ext: "tar.gz",
    exe: "tectonic",
    archiveSha256: "24bd46566fa30d41101848405e9cbc4645edb92d8f857c9d21262174fb70cd33",
    exeSha256: "7b8efd258bf04fcd4d200e3e64faa47abc82671285a35c3af2018d2f03ecc890",
  },
  "linux:x64": {
    triple: "x86_64-unknown-linux-musl",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    ext: "tar.gz",
    exe: "tectonic",
    archiveSha256: "dfb82876f2986862996e564fa507a9e576e0c1e3bee63c2c1bd677c2543e6407",
    exeSha256: "4df19452c202c5bef9f7c7e4a01a3f2b9d5199f0a1f73b70b4fe1bffbc9837f6",
  },
};

/** Throws unless `url` is https on an allowlisted host. */
export function assertAllowedUrl(url) {
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error(`Refusing to fetch a malformed URL: ${url}`);
  }
  if (parsed.protocol !== "https:") {
    throw new Error(`Refusing a non-https URL: ${parsed.protocol}//${parsed.host}`);
  }
  if (!ALLOWED_HOSTS.has(parsed.hostname)) {
    throw new Error(
      `Refusing a redirect to an unexpected host: ${parsed.hostname}. ` +
        `Allowed: ${[...ALLOWED_HOSTS].join(", ")}.`,
    );
  }
  return parsed;
}

export async function sha256File(path) {
  return createHash("sha256").update(await readFile(path)).digest("hex");
}
