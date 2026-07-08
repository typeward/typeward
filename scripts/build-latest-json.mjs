#!/usr/bin/env node
// Assemble the Tauri updater manifest (latest.json) from the `.sig` files a
// signed build produced. Hand-rolled on purpose (rather than tauri-action's
// built-in generation) so the cross-repo asset URLs are explicit and the whole
// step is transparent — the release publishes to the PUBLIC typeward/releases
// repo, not this private one.
//
//   node scripts/build-latest-json.mjs \
//     --dir <collected-artifacts-dir> \
//     --version <x.y.z> \
//     --base-url https://github.com/typeward/releases/releases/download/v<x.y.z> \
//     --notes-file <path> \
//     --out latest.json
//
// If NO `.sig` files are found (an unsigned build — the dormant default), no
// manifest is written and the process exits 0: there is simply no updater feed
// to publish yet.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

const dir = arg("dir", ".");
const version = arg("version");
const baseUrl = (arg("base-url") ?? "").replace(/\/+$/, "");
const notesFile = arg("notes-file");
const outPath = arg("out", "latest.json");

if (!version) {
  console.error("build-latest-json: --version is required");
  process.exit(1);
}
if (!baseUrl) {
  console.error("build-latest-json: --base-url is required");
  process.exit(1);
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// Map an updater bundle filename to a Tauri updater platform key. The bundle is
// the file the `.sig` sits next to; its extension identifies the OS and the
// filename usually carries the arch.
function platformKey(file) {
  const lower = file.toLowerCase();
  const isArm = /aarch64|arm64/.test(lower);
  const isX64 = /x64|x86_64|amd64/.test(lower);
  if (lower.endsWith(".app.tar.gz")) {
    return isX64 ? "darwin-x86_64" : "darwin-aarch64";
  }
  if (lower.endsWith(".appimage")) {
    return isArm ? "linux-aarch64" : "linux-x86_64";
  }
  // NSIS setup .exe (the only Windows updater target we ship).
  if (lower.endsWith(".exe")) {
    return isArm ? "windows-aarch64" : "windows-x86_64";
  }
  return null;
}

const files = walk(dir);
const sigs = files.filter((f) => f.toLowerCase().endsWith(".sig"));

if (sigs.length === 0) {
  console.log(
    "build-latest-json: no .sig files found — unsigned build, skipping latest.json.",
  );
  process.exit(0);
}

const platforms = {};
for (const sigPath of sigs) {
  const bundlePath = sigPath.replace(/\.sig$/i, "");
  const bundleName = bundlePath.split(/[\\/]/).pop();
  const key = platformKey(bundleName);
  if (!key) {
    console.warn(`build-latest-json: unrecognized bundle for signature: ${bundleName}`);
    continue;
  }
  const signature = readFileSync(sigPath, "utf8").trim();
  if (platforms[key]) {
    console.warn(`build-latest-json: multiple bundles map to ${key}; using ${bundleName}`);
  }
  platforms[key] = {
    signature,
    url: `${baseUrl}/${encodeURIComponent(bundleName)}`,
  };
}

if (Object.keys(platforms).length === 0) {
  console.log("build-latest-json: signatures found but none mapped to a platform; skipping.");
  process.exit(0);
}

const notes =
  notesFile && statSafe(notesFile) ? readFileSync(notesFile, "utf8").trim() : "";

const manifest = {
  version,
  notes,
  pub_date: new Date().toISOString(),
  platforms,
};

writeFileSync(outPath, JSON.stringify(manifest, null, 2) + "\n");
console.log(
  `build-latest-json: wrote ${outPath} for v${version} (${Object.keys(platforms).join(", ")}).`,
);

function statSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}
