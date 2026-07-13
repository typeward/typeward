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

import { createWriteStream } from "node:fs";
import { mkdir, rm, chmod, readdir, rename, readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, arch, platform } from "node:os";
import { spawn } from "node:child_process";
import { get } from "node:https";

const TECTONIC_VERSION = "0.15.0";

// Release assets are served from github.com and redirect to GitHub's asset
// CDN. A redirect to anything else is an attack, not a mirror.
const ALLOWED_HOSTS = new Set([
  "github.com",
  "objects.githubusercontent.com",
  "release-assets.githubusercontent.com",
]);
const MAX_REDIRECTS = 5;

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

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const targetDir = join(repoRoot, "src-tauri", "binaries");

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

async function verifyFile(path, expected, what) {
  const actual = await sha256File(path);
  if (actual !== expected) {
    throw new Error(
      `SHA-256 mismatch for ${what}\n  expected ${expected}\n  actual   ${actual}\n` +
        `Refusing to install it. Either the pinned digest in scripts/fetch-tectonic.mjs is ` +
        `stale (bump it deliberately after checking the upstream release) or the download ` +
        `was tampered with.`,
    );
  }
}

async function main() {
  const key = `${platform()}:${arch()}`;
  const spec = PLATFORMS[key];
  if (!spec) {
    console.error(`Unsupported platform: ${key}`);
    console.error(`Add an entry to PLATFORMS in this script if you need one.`);
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
    await rename(found, finalPath);
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
