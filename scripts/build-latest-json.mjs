#!/usr/bin/env node
// Assemble the Tauri updater manifest (latest.json) from the `.sig` files a
// signed build produced. Hand-rolled on purpose (rather than tauri-action's
// built-in generation) so the asset URLs and the platform-key mapping are
// explicit and reviewable.
//
//   node scripts/build-latest-json.mjs \
//     --dir <collected-artifacts-dir> \
//     --version <x.y.z> \
//     --base-url https://github.com/typeward/typeward/releases/download/v<x.y.z> \
//     --notes-file <path> \
//     --expect windows-x86_64,darwin-aarch64 \
//     --out latest.json
//
// If NO `.sig` files are found (an unsigned build), no manifest is written and
// the process exits 0: there is simply no updater feed to publish.
//
// PLATFORM KEYS. The updater plugin resolves a download by trying
// `{os}-{arch}-{installer}` first and `{os}-{arch}` second, where `installer`
// comes from a string the bundler patches into each binary it produces
// (tauri::utils::platform::bundle_type). So a `.deb` install asks for
// `linux-x86_64-deb` before `linux-x86_64`, and it can only be updated by a
// `.deb` - the Linux install path dispatches on the installed package type and
// rejects bytes of any other format.
//
// That is why Linux gets per-package keys and DELIBERATELY NO generic
// `linux-<arch>` key. With a generic key, a `.deb` user whose `.deb` was not
// signed would silently fall through to the AppImage, download it in full, and
// only then fail with "invalid updater binary format". Without one, the same
// user fails at check time with a clear target-not-found, which the frontend
// turns into an accurate message (see src/lib/updater.ts). Windows and macOS
// ship exactly one updater target each, so their generic key is unambiguous
// and is emitted as a fallback for binaries the bundler never patched.

import { readFileSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

// Longest-first: `x86_64` must win over `x86`, `aarch64`/`arm64` over `arm`.
const ARCH_PATTERNS = [
  [/(?:^|[^a-z0-9])(?:aarch64|arm64)(?:[^a-z0-9]|$)/, "aarch64"],
  [/(?:^|[^a-z0-9])(?:x86_64|amd64|x64)(?:[^a-z0-9]|$)/, "x86_64"],
  [/(?:^|[^a-z0-9])(?:armv7|armv7l|armhf)(?:[^a-z0-9]|$)/, "armv7"],
  [/(?:^|[^a-z0-9])(?:i686|i386|x86)(?:[^a-z0-9]|$)/, "i686"],
];

/** Arch token carried by a Tauri bundle filename, or null when absent. */
export function archOf(fileName) {
  const lower = fileName.toLowerCase();
  for (const [re, arch] of ARCH_PATTERNS) {
    if (re.test(lower)) return arch;
  }
  return null;
}

/**
 * Platform keys a bundle should be published under, most specific first.
 * Returns [] for a file that is not an updater target.
 */
export function platformKeysFor(fileName) {
  const lower = fileName.toLowerCase();
  const arch = archOf(fileName);

  // macOS: the updater bundle is the .app tarball. Tauri names it after
  // productName alone, so release.yml renames it to carry the rust target
  // triple - that triple is where the arch token comes from.
  if (lower.endsWith(".app.tar.gz")) {
    const a = arch ?? "aarch64";
    return [`darwin-${a}-app`, `darwin-${a}`];
  }

  // Linux. Per-package keys only, no generic fallback (see the header note).
  if (lower.endsWith(".appimage") || lower.endsWith(".appimage.tar.gz")) {
    return arch ? [`linux-${arch}-appimage`] : [];
  }
  if (lower.endsWith(".deb")) {
    return arch ? [`linux-${arch}-deb`] : [];
  }
  if (lower.endsWith(".rpm")) {
    return arch ? [`linux-${arch}-rpm`] : [];
  }

  // Windows: NSIS is the only updater target we ship (tauri.conf.json drops
  // msi), so the generic key is unambiguous.
  if (lower.endsWith("-setup.exe") || lower.endsWith(".exe")) {
    const a = arch ?? "x86_64";
    return [`windows-${a}-nsis`, `windows-${a}`];
  }

  return [];
}

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function walk(root, out = []) {
  for (const entry of readdirSync(root, { withFileTypes: true })) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

function statSafe(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function main() {
  const dir = arg("dir", ".");
  const version = arg("version");
  const baseUrl = (arg("base-url") ?? "").replace(/\/+$/, "");
  const notesFile = arg("notes-file");
  const outPath = arg("out", "latest.json");
  const expect = (arg("expect") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  if (!version) {
    console.error("build-latest-json: --version is required");
    process.exit(1);
  }
  if (!baseUrl) {
    console.error("build-latest-json: --base-url is required");
    process.exit(1);
  }

  const files = walk(dir);
  const sigs = files.filter((f) => f.toLowerCase().endsWith(".sig"));

  if (sigs.length === 0) {
    console.log(
      "build-latest-json: no .sig files found, unsigned build, skipping latest.json.",
    );
    process.exit(0);
  }

  const platforms = {};
  for (const sigPath of sigs) {
    const bundlePath = sigPath.replace(/\.sig$/i, "");
    const bundleName = bundlePath.split(/[\\/]/).pop();
    const keys = platformKeysFor(bundleName);
    if (keys.length === 0) {
      console.warn(
        `build-latest-json: unrecognized bundle for signature: ${bundleName}`,
      );
      continue;
    }
    const signature = readFileSync(sigPath, "utf8").trim();
    const entry = {
      signature,
      url: `${baseUrl}/${encodeURIComponent(bundleName)}`,
    };
    for (const key of keys) {
      // First writer wins: a specific key claimed by its own bundle must not be
      // overwritten by another bundle's generic fallback.
      if (platforms[key]) {
        console.warn(
          `build-latest-json: ${key} already mapped, keeping the first bundle and skipping ${bundleName}`,
        );
        continue;
      }
      platforms[key] = entry;
    }
  }

  const produced = Object.keys(platforms).sort();
  if (produced.length === 0) {
    console.log(
      "build-latest-json: signatures found but none mapped to a platform; skipping.",
    );
    process.exit(0);
  }

  // A leg that built but whose .sig never reached the collector would silently
  // strand every user on that platform with no update for the whole release.
  const missing = expect.filter((k) => !platforms[k]);
  if (missing.length > 0) {
    console.error(
      `build-latest-json: expected platform keys are missing from the manifest: ${missing.join(", ")}`,
    );
    console.error(`build-latest-json: produced keys: ${produced.join(", ")}`);
    process.exit(1);
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
    `build-latest-json: wrote ${outPath} for v${version} (${produced.join(", ")}).`,
  );
}

// Importable for tests; only the CLI invocation runs the pipeline.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
