#!/usr/bin/env node
// Download the Tectonic binary for the current host platform and place it
// at src-tauri/binaries/tectonic-<target-triple><.exe>, which is the path
// Tauri's sidecar mechanism expects (see tauri.conf.json → bundle.externalBin).
//
// Run: npm run fetch:tectonic
//
// Pinned to a known-good release. This binary SHIPS as a sidecar inside the
// signed installers, so it is a supply-chain input: every byte is verified
// against a digest recorded here before it is extracted or installed, and an
// already-present file is re-verified rather than trusted. Bump
// TECTONIC_VERSION together with BOTH digests per platform (compute them from
// the release assets — never copy them from an unverified source).
//
// The pinned version, digest table, and URL/host guards live in the sibling
// fetch-tectonic.lib.mjs (a shebang-free module) so the supply-chain test can
// import them without Vitest's Rolldown transform tripping over this shebang.
//
// Windows on ARM: upstream ships NO aarch64-pc-windows-msvc build (0.15.0 has
// only x86_64 Windows assets). Windows 11 on ARM runs x64 binaries under its
// built-in emulation, so the `win32:arm64` entry deliberately downloads the
// x86_64 archive and installs it under the aarch64 target-triple name that
// Tauri's `externalBin` resolves for an ARM64 build — same archive, same
// digests as win32:x64, it just runs emulated. (The desktop release matrix has
// no Windows/arm64 leg; this only unblocks local ARM64 dev builds.)

import { createWriteStream } from "node:fs";
import { mkdir, rm, chmod, readdir, rename, copyFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, arch, platform } from "node:os";
import { spawn } from "node:child_process";
import { get } from "node:https";

import {
  TECTONIC_VERSION,
  MAX_REDIRECTS,
  PLATFORMS,
  assertAllowedUrl,
  sha256File,
} from "./fetch-tectonic.lib.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const targetDir = join(repoRoot, "src-tauri", "binaries");

async function verifyFile(path, expected, what) {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${what}\n  expected ${expected}\n  actual   ${actual}\n` +
        `Refusing to install it. Either the pinned digest in scripts/fetch-tectonic.lib.mjs is ` +
        `stale (bump it deliberately after checking the upstream release) or the download ` +
        `was tampered with.`,
    );
  }
}

// Move the verified binary into place. `rename` is atomic but only within one
// filesystem; on Windows CI the OS temp dir (C:) and the checkout (D:) are on
// different drives, so a bare rename throws EXDEV. Fall back to copy + remove,
// which crosses devices.
async function moveInto(src, dest) {
  try {
    await rename(src, dest);
  } catch (e) {
    if (e.code !== "EXDEV") throw e;
    await copyFile(src, dest);
    await rm(src, { force: true });
  }
}

async function main() {
  const key = `${platform()}:${arch()}`;
  const spec = PLATFORMS[key];
  if (!spec) {
    console.error(`Unsupported platform: ${key}`);
    console.error(`Add an entry to PLATFORMS in scripts/fetch-tectonic.lib.mjs if you need one.`);
    process.exit(1);
  }

  const url = `https://github.com/tectonic-typesetting/tectonic/releases/download/tectonic@${TECTONIC_VERSION}/${spec.archive}`;
  const finalName = `tectonic-${spec.triple}${platform() === "win32" ? ".exe" : ""}`;
  const finalPath = join(targetDir, finalName);

  // An existing file is a cache, not a trust anchor: hash it. A stale binary
  // from an older pin — or a planted one — must not be silently shipped.
  try {
    await verifyFile(finalPath, spec.exeSha256, finalPath);
    console.log(`Tectonic already in place and verified: ${finalPath}`);
    return;
  } catch (e) {
    if (e.code === "ENOENT") {
      /* not present; download */
    } else {
      console.warn(`Re-downloading: ${e.message}`);
      await rm(finalPath, { force: true });
    }
  }

  console.log(`Downloading ${url} ...`);
  await mkdir(targetDir, { recursive: true });
  const work = join(tmpdir(), `typeward-tectonic-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const archivePath = join(work, spec.archive);

  try {
    await download(url, archivePath);
    await verifyFile(archivePath, spec.archiveSha256, spec.archive);
    await extract(archivePath, work, spec.ext);

    // Find the extracted binary (may be at root or in a subdir).
    const found = await findBinary(work, spec.exe);
    if (!found) {
      throw new Error(`Could not find ${spec.exe} in extracted archive at ${work}`);
    }
    await verifyFile(found, spec.exeSha256, `${spec.exe} (extracted)`);
    await moveInto(found, finalPath);
    if (platform() !== "win32") {
      await chmod(finalPath, 0o755);
    }
  } finally {
    await rm(work, { recursive: true, force: true });
  }
  console.log(`Installed → ${finalPath}`);
  console.log("Tauri's `externalBin: [\"binaries/tectonic\"]` resolves this path automatically.");
}

function download(url, dest, hops = 0) {
  const parsed = assertAllowedUrl(url);
  return new Promise((resolveP, rejectP) => {
    const req = get(parsed, (res) => {
      // Follow GitHub's redirect to its asset CDN. Don't open the destination
      // file until we have a 200 response — otherwise concurrent recursive
      // calls fight over the same path and Windows locks the file.
      if (res.statusCode >= 300 && res.statusCode < 400) {
        res.resume();
        if (hops >= MAX_REDIRECTS) {
          rejectP(new Error(`Too many redirects (>${MAX_REDIRECTS}) fetching ${url}`));
          return;
        }
        const next = res.headers.location;
        if (!next) {
          rejectP(new Error("Redirect without Location header"));
          return;
        }
        download(new URL(next, parsed).toString(), dest, hops + 1).then(resolveP, rejectP);
        return;
      }
      if (res.statusCode !== 200) {
        rejectP(new Error(`HTTP ${res.statusCode} fetching ${url}`));
        res.resume();
        return;
      }
      const file = createWriteStream(dest);
      res.pipe(file);
      file.on("finish", () => file.close(() => resolveP()));
      file.on("error", rejectP);
    });
    req.on("error", rejectP);
  });
}

function extract(archivePath, destDir, ext) {
  return new Promise((resolveP, rejectP) => {
    let cmd;
    let args;
    if (ext === "zip" && platform() === "win32") {
      // GNU tar (shipped with git-bash) cannot read zip files, and we can't
      // reliably distinguish git-bash tar from System32 tar from npm. Use
      // PowerShell's Expand-Archive which is always available on Windows 10+.
      cmd = "powershell.exe";
      args = [
        "-NoProfile",
        "-NonInteractive",
        "-Command",
        `Expand-Archive -LiteralPath '${archivePath}' -DestinationPath '${destDir}' -Force`,
      ];
    } else if (ext === "zip") {
      cmd = "unzip";
      args = ["-q", archivePath, "-d", destDir];
    } else {
      cmd = "tar";
      args = ["-xzf", archivePath, "-C", destDir];
    }
    const child = spawn(cmd, args, { stdio: "inherit" });
    child.on("error", rejectP);
    child.on("exit", (code) => {
      if (code === 0) resolveP();
      else rejectP(new Error(`${cmd} ${args.join(" ")} exited ${code}`));
    });
  });
}

async function findBinary(root, name) {
  const stack = [root];
  while (stack.length) {
    const dir = stack.pop();
    const entries = await readdir(dir, { withFileTypes: true });
    for (const e of entries) {
      const p = join(dir, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (e.name === name) return p;
    }
  }
  return null;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
