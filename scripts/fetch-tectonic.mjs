#!/usr/bin/env node
// Download the Tectonic binary for the current host platform and place it
// at src-tauri/binaries/tectonic-<target-triple><.exe>, which is the path
// Tauri's sidecar mechanism expects (see tauri.conf.json → bundle.externalBin).
//
// Run: npm run fetch:tectonic
//
// Pinned to a known-good release; bump TECTONIC_VERSION when upgrading.

import { createWriteStream } from "node:fs";
import { mkdir, rm, chmod, readdir, rename, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { tmpdir, arch, platform } from "node:os";
import { spawn } from "node:child_process";
import { get } from "node:https";

const TECTONIC_VERSION = "0.15.0";

const PLATFORMS = {
  // node platform/arch → { triple, archive, ext, exe }
  "win32:x64": {
    triple: "x86_64-pc-windows-msvc",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-pc-windows-msvc.zip`,
    ext: "zip",
    exe: "tectonic.exe",
  },
  "darwin:x64": {
    triple: "x86_64-apple-darwin",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-apple-darwin.tar.gz`,
    ext: "tar.gz",
    exe: "tectonic",
  },
  "darwin:arm64": {
    triple: "aarch64-apple-darwin",
    archive: `tectonic-${TECTONIC_VERSION}-aarch64-apple-darwin.tar.gz`,
    ext: "tar.gz",
    exe: "tectonic",
  },
  "linux:x64": {
    triple: "x86_64-unknown-linux-musl",
    archive: `tectonic-${TECTONIC_VERSION}-x86_64-unknown-linux-musl.tar.gz`,
    ext: "tar.gz",
    exe: "tectonic",
  },
};

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");
const targetDir = join(repoRoot, "src-tauri", "binaries");

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

  // Skip if already present.
  try {
    await stat(finalPath);
    console.log(`Tectonic already in place: ${finalPath}`);
    return;
  } catch {
    /* not present; download */
  }

  console.log(`Downloading ${url} ...`);
  await mkdir(targetDir, { recursive: true });
  const work = join(tmpdir(), `typeward-tectonic-${Date.now()}`);
  await mkdir(work, { recursive: true });
  const archivePath = join(work, spec.archive);

  await download(url, archivePath);
  await extract(archivePath, work, spec.ext);

  // Find the extracted binary (may be at root or in a subdir).
  const found = await findBinary(work, spec.exe);
  if (!found) {
    console.error(`Could not find ${spec.exe} in extracted archive at ${work}`);
    process.exit(2);
  }
  await rename(found, finalPath);
  if (platform() !== "win32") {
    await chmod(finalPath, 0o755);
  }
  await rm(work, { recursive: true, force: true });
  console.log(`Installed → ${finalPath}`);
  console.log("Tauri's `externalBin: [\"binaries/tectonic\"]` resolves this path automatically.");
}

function download(url, dest) {
  return new Promise((resolveP, rejectP) => {
    const req = get(url, (res) => {
      // Follow GitHub redirect to S3. Don't open the destination file
      // until we have a 200 response — otherwise concurrent recursive
      // calls fight over the same path and Windows locks the file.
      if (res.statusCode === 301 || res.statusCode === 302) {
        const next = res.headers.location;
        if (!next) {
          rejectP(new Error("Redirect without Location header"));
          return;
        }
        res.resume();
        download(next, dest).then(resolveP, rejectP);
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

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
