#!/usr/bin/env node
// Single-command version bump for a release.
//
//   npm run release -- <x.y.z>            perform the bump
//   npm run release -- <x.y.z> --dry-run  print the plan, write nothing
//
// Writes the one version into every place it's duplicated, refreshes the app's
// Cargo.lock entry, then commits + tags. The four version sources kept in sync:
//   - package.json          (via `npm version`, which also updates package-lock.json)
//   - src-tauri/tauri.conf.json
//   - src-tauri/Cargo.toml   ([package].version)
//   - src-tauri/Cargo.lock   (the `typeward` package entry)
//
// Cargo.lock refresh mechanism: `cargo update -p typeward --offline`. Because
// only the root package's own version changed (no dependency graph change), this
// reconciles the single lock entry without any network access — the cheap,
// correct move on this repo (verified). package-lock.json is refreshed by
// `npm version --no-git-tag-version` for the same in-sync reason (so CI's
// `npm ci` doesn't reject a version-drifted lock).
//
// Pushing the tag is intentionally NOT done here — that's the human trigger for
// release.yml. Refuses to run on a dirty tree so the release commit is clean.

import { readFileSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const version = args.find((a) => !a.startsWith("-"));

// Plain X.Y.Z, optionally a prerelease suffix (e.g. 0.2.0-beta.1). Matches what
// Tauri and Cargo accept; the git tag is `v<version>`.
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?$/;

function die(msg) {
  console.error(`bump-version: ${msg}`);
  process.exit(1);
}

if (!version) {
  die("usage: npm run release -- <x.y.z> [--dry-run]");
}
if (!SEMVER.test(version)) {
  die(`"${version}" is not a valid semver version (expected x.y.z).`);
}

const tag = `v${version}`;

function git(cmdArgs) {
  return execFileSync("git", cmdArgs, { cwd: repoRoot, encoding: "utf8" }).trim();
}

// --- pre-flight -----------------------------------------------------------

const dirty = git(["status", "--porcelain"]);
if (dirty) {
  if (dryRun) {
    console.warn(
      "note: working tree is dirty — a real run would refuse. Continuing (dry-run only prints).",
    );
  } else {
    die("working tree is dirty. Commit or stash first — the release commit must be clean.");
  }
}

// A tag collision would make the real `git tag` fail after files were written.
const tagExists = (() => {
  try {
    git(["rev-parse", "-q", "--verify", `refs/tags/${tag}`]);
    return true;
  } catch {
    return false;
  }
})();
if (tagExists) {
  die(`tag ${tag} already exists.`);
}

// --- read current versions (for the plan) ---------------------------------

const pkgPath = join(repoRoot, "package.json");
const confPath = join(repoRoot, "src-tauri", "tauri.conf.json");
const cargoPath = join(repoRoot, "src-tauri", "Cargo.toml");

const pkg = JSON.parse(readFileSync(pkgPath, "utf8"));
const confText = readFileSync(confPath, "utf8");
const cargoText = readFileSync(cargoPath, "utf8");

const currentPkg = pkg.version;
const currentConf = confText.match(/"version"\s*:\s*"([^"]+)"/)?.[1];
// [package].version is the first line-anchored `version = "..."`; inline
// dependency versions live inside `{ version = "2", ... }` and never match ^.
const currentCargo = cargoText.match(/^version = "([^"]+)"/m)?.[1];

console.log(`Planned release: ${tag}`);
console.log(`  package.json      ${currentPkg} -> ${version}  (+ package-lock.json)`);
console.log(`  tauri.conf.json   ${currentConf} -> ${version}`);
console.log(`  Cargo.toml        ${currentCargo} -> ${version}  (+ Cargo.lock via cargo update)`);
console.log(`  git commit        chore(release): ${tag}`);
console.log(`  git tag           ${tag}  (not pushed)`);

if (dryRun) {
  console.log("\n--dry-run: no files written, nothing committed or tagged.");
  process.exit(0);
}

// --- write ----------------------------------------------------------------

// package.json + package-lock.json in one canonical step.
execFileSync(
  "npm",
  ["version", version, "--no-git-tag-version", "--allow-same-version"],
  { cwd: repoRoot, stdio: "inherit", shell: process.platform === "win32" },
);

// tauri.conf.json: replace only the top-level version (the sole "version" key).
writeFileSync(
  confPath,
  confText.replace(/("version"\s*:\s*")[^"]+(")/, `$1${version}$2`),
);

// Cargo.toml: replace only [package].version (line-anchored).
writeFileSync(
  cargoPath,
  cargoText.replace(/^version = "[^"]+"/m, `version = "${version}"`),
);

// Cargo.lock: reconcile the single `typeward` entry, offline.
execFileSync(
  "cargo",
  ["update", "--manifest-path", "src-tauri/Cargo.toml", "-p", "typeward", "--offline"],
  { cwd: repoRoot, stdio: "inherit" },
);

// --- commit + tag ---------------------------------------------------------

git([
  "add",
  "package.json",
  "package-lock.json",
  "src-tauri/tauri.conf.json",
  "src-tauri/Cargo.toml",
  "src-tauri/Cargo.lock",
]);
git(["commit", "-m", `chore(release): ${tag}`]);
git(["tag", tag]);

console.log(`\nDone. Committed and tagged ${tag}.`);
console.log(`Push it to trigger the release build:  git push && git push origin ${tag}`);
