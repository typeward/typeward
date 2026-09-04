#!/usr/bin/env node
// Local end-to-end harness for the auto-updater.
//
// The updater is the one feature that cannot be exercised by a unit test: it
// spans a signed bundle, a manifest, an HTTP fetch, a minisign verification and
// an OS installer. This drives all of that against a loopback server so the
// whole chain can be proven before a tag is ever pushed.
//
// Everything it writes lives under `.updater-local-test/` (gitignored).
//
//   node scripts/updater-local-test.mjs fake --version 9.9.9
//       Sign a placeholder payload and build a manifest for it. Seconds, not
//       minutes. Proves: endpoint reachable, manifest parsed, version compared,
//       platform key matched, download completed, SIGNATURE VERIFIED. This is
//       the fast loop.
//
//       PRESSING INSTALL IS ONLY SAFE ON WINDOWS. There the plugin sniffs the
//       payload (`infer::app::is_exe`) and rejects a non-installer with
//       "invalid updater binary format" before running anything, so the app
//       survives with an error toast. macOS and Linux have no such check: the
//       macOS path moves the extracted archive over the .app bundle, and the
//       Linux path writes the downloaded bytes straight over the running
//       executable. On those platforms use `fake` to exercise check + download
//       + verify, and `bundle` when you want to test the install itself.
//
//   node scripts/updater-local-test.mjs bundle --version 9.9.9
//       Build a real signed installer at that version and put it in the feed.
//       Slow (a full release build), and the only mode that also proves the OS
//       install + restart. Needs the signing key in the environment.
//
//   node scripts/updater-local-test.mjs serve [--port 8787]
//       Serve the feed directory over http://127.0.0.1:<port>.
//
// Then, in a second terminal:
//
//   npm run tauri dev -- --config .updater-local-test/endpoint.conf.json
//
// and use Settings > About > Check now. The app's own version comes from
// tauri.conf.json, so any --version above it is seen as an update.
//
// WHY AN OVERLAY, AND WHY IT IS SAFE. The endpoint override lives in a
// generated file, never in the checked-in config, so no build can pick it up by
// accident. It sets `dangerousInsecureTransportProtocol` because the plugin
// refuses non-https endpoints in release builds; a debug build only warns.

import { spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { platformKeysFor } from "./build-latest-json.mjs";

const repoRoot = resolve(fileURLToPath(new URL("..", import.meta.url)));
const workDir = join(repoRoot, ".updater-local-test");
const feedDir = join(workDir, "feed");
const overlayPath = join(workDir, "endpoint.conf.json");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : fallback;
}

function fail(message) {
  console.error(`updater-local-test: ${message}`);
  process.exit(1);
}

function keyEnv() {
  const env = { ...process.env };
  // The bundler only reads TAURI_SIGNING_PRIVATE_KEY (the key itself), while
  // `signer sign` also accepts a path. Resolve everything down to the key
  // string so both consumers work from one setting; a path-only environment
  // otherwise builds fine and then fails at the signing step with "a public
  // key has been found, but no private key".
  if (!env.TAURI_SIGNING_PRIVATE_KEY) {
    const keyPath =
      env.TAURI_SIGNING_PRIVATE_KEY_PATH ||
      join(process.env.USERPROFILE || process.env.HOME || "", ".tauri", "typeward.key");
    if (!existsSync(keyPath)) {
      fail(
        "no signing key. Set TAURI_SIGNING_PRIVATE_KEY (or " +
          "TAURI_SIGNING_PRIVATE_KEY_PATH) and " +
          "TAURI_SIGNING_PRIVATE_KEY_PASSWORD, or generate one with " +
          "`npx tauri signer generate -w ~/.tauri/typeward.key`.",
      );
    }
    env.TAURI_SIGNING_PRIVATE_KEY = readFileSync(keyPath, "utf8").trim();
  }
  if (env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD === undefined) {
    // The CLI prompts interactively for a missing password, which would hang a
    // non-interactive run. An empty value means "no password".
    env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD = "";
  }
  return env;
}

/** Name a placeholder payload so platformKeysFor classifies it like the real
 *  bundle this platform ships. */
function fakeBundleName(version) {
  const arch = process.arch === "arm64" ? "aarch64" : "x86_64";
  if (process.platform === "win32") {
    return `Typeward_${version}_${arch === "aarch64" ? "arm64" : "x64"}-setup.exe`;
  }
  if (process.platform === "darwin") {
    return `Typeward_${arch}-apple-darwin.app.tar.gz`;
  }
  return `Typeward_${version}_${arch === "aarch64" ? "aarch64" : "amd64"}.AppImage`;
}

// Node refuses to spawn a .cmd shim without a shell on Windows, and npm/npx are
// exactly that. Under `shell: true` an args array is concatenated unescaped, so
// pass one already-quoted command string instead: paths here can contain spaces.
function shellRun(parts, opts) {
  const command = parts
    .map((p) => (/[\s"]/.test(p) ? `"${p.replace(/"/g, '\\"')}"` : p))
    .join(" ");
  return spawnSync(command, { cwd: repoRoot, env: keyEnv(), shell: true, ...opts });
}

function sign(filePath) {
  const res = shellRun(["npx", "tauri", "signer", "sign", filePath], {
    encoding: "utf8",
  });
  if (res.status !== 0) {
    fail(
      `signing failed (exit ${res.status}):\n${res.stdout ?? ""}${res.stderr ?? ""}${
        res.error ? String(res.error) : ""
      }`,
    );
  }
  const sigPath = `${filePath}.sig`;
  if (!existsSync(sigPath)) {
    fail(`signer reported success but wrote no ${sigPath}`);
  }
  return sigPath;
}

function writeManifest(version, port) {
  const files = readdirSync(feedDir).filter((f) => f.toLowerCase().endsWith(".sig"));
  if (files.length === 0) {
    fail(`no signed artifacts in ${feedDir}. Run the 'fake' or 'bundle' mode first.`);
  }
  const platforms = {};
  for (const sigName of files) {
    const bundleName = sigName.replace(/\.sig$/i, "");
    const keys = platformKeysFor(bundleName);
    if (keys.length === 0) {
      console.warn(`updater-local-test: skipping unrecognized bundle ${bundleName}`);
      continue;
    }
    const entry = {
      signature: readFileSync(join(feedDir, sigName), "utf8").trim(),
      url: `http://127.0.0.1:${port}/${encodeURIComponent(bundleName)}`,
    };
    for (const key of keys) platforms[key] ??= entry;
  }
  const manifest = {
    version,
    notes:
      "Local updater test build.\n\nThis release exists only on your machine, served from a loopback HTTP server by scripts/updater-local-test.mjs.",
    pub_date: new Date().toISOString(),
    platforms,
  };
  writeFileSync(join(feedDir, "latest.json"), JSON.stringify(manifest, null, 2) + "\n");
  return manifest;
}

function writeOverlay(port) {
  const overlay = {
    plugins: {
      updater: {
        endpoints: [`http://127.0.0.1:${port}/latest.json`],
        dangerousInsecureTransportProtocol: true,
      },
    },
  };
  writeFileSync(overlayPath, JSON.stringify(overlay, null, 2) + "\n");
}

function readVersionFromConf() {
  const conf = JSON.parse(
    readFileSync(join(repoRoot, "src-tauri", "tauri.conf.json"), "utf8"),
  );
  return String(conf.version);
}

function cmdFake() {
  const version = arg("version", "9.9.9");
  mkdirSync(feedDir, { recursive: true });
  const name = fakeBundleName(version);
  const target = join(feedDir, name);
  writeFileSync(
    target,
    `Typeward updater local test payload for ${version}.\n` +
      "Not a real installer: the download and signature check succeed, the OS install step fails.\n",
  );
  sign(target);
  console.log(`updater-local-test: signed placeholder ${name}`);
  if (process.platform !== "win32") {
    console.log("");
    console.log(
      "  WARNING: do NOT press Install with this placeholder on " +
        `${process.platform}. Only Windows validates the payload format before ` +
        "running it; here the plugin would overwrite the app bundle or the " +
        "running executable with this file. Use it to test check, download and " +
        "signature verification, and use `bundle` mode to test installing.",
    );
    console.log("");
  }
  console.log(
    "updater-local-test: next, run `node scripts/updater-local-test.mjs serve`",
  );
}

function cmdBundle() {
  const version = arg("version", "9.9.9");
  // A debug build skips LTO and opt-level=s, which is minutes instead of tens
  // of minutes, and still produces a real installer through the real bundler.
  const debug = process.argv.includes("--debug");
  // Bake the loopback endpoint into the built app. This is what makes it
  // possible to install an OLD version and watch it update itself: an installed
  // app reads the endpoint compiled into it, so it cannot be redirected later.
  const localEndpoint = process.argv.includes("--endpoint");
  const port = Number(arg("port", "8787"));
  const stage = arg("stage", "feed");
  const outDir = stage === "feed" ? feedDir : join(workDir, stage);

  mkdirSync(workDir, { recursive: true });
  const buildOverlay = join(workDir, `build-${version}.conf.json`);
  const overlay = { version, bundle: { createUpdaterArtifacts: true } };
  if (localEndpoint) {
    overlay.plugins = {
      updater: {
        endpoints: [`http://127.0.0.1:${port}/latest.json`],
        dangerousInsecureTransportProtocol: true,
      },
    };
  }
  writeFileSync(buildOverlay, JSON.stringify(overlay, null, 2) + "\n");
  console.log(
    `updater-local-test: building a signed ${version} bundle${debug ? " (debug)" : ""}` +
      `${localEndpoint ? ` pointed at 127.0.0.1:${port}` : ""}. This takes a while.`,
  );
  const res = shellRun(
    [
      "npm",
      "run",
      "tauri",
      "--",
      "build",
      "--config",
      buildOverlay,
      ...(debug ? ["--debug"] : []),
    ],
    { stdio: "inherit" },
  );
  if (res.status !== 0) fail("tauri build failed");

  mkdirSync(outDir, { recursive: true });
  const bundleRoot = join(
    repoRoot,
    "src-tauri",
    "target",
    debug ? "debug" : "release",
    "bundle",
  );
  let copied = 0;
  for (const dir of ["nsis", "appimage", "macos", "deb", "rpm"]) {
    const full = join(bundleRoot, dir);
    if (!existsSync(full)) continue;
    for (const name of readdirSync(full)) {
      if (!name.includes(version)) continue;
      if (platformKeysFor(name).length === 0 && !name.endsWith(".sig")) continue;
      writeFileSync(join(outDir, name), readFileSync(join(full, name)));
      copied++;
    }
  }
  if (copied === 0) fail(`no ${version} artifacts found under ${bundleRoot}`);
  console.log(`updater-local-test: copied ${copied} files into ${outDir}`);
}

const MIME = {
  ".json": "application/json",
  ".exe": "application/octet-stream",
  ".gz": "application/gzip",
  ".appimage": "application/octet-stream",
  ".deb": "application/vnd.debian.binary-package",
  ".rpm": "application/x-rpm",
};

function cmdServe() {
  const port = Number(arg("port", "8787"));
  if (!existsSync(feedDir)) {
    fail(`${feedDir} does not exist. Run the 'fake' or 'bundle' mode first.`);
  }
  const bundles = readdirSync(feedDir).filter((f) => f.toLowerCase().endsWith(".sig"));
  const version =
    arg("version") ??
    (bundles
      .map((f) => f.match(/_(\d+\.\d+\.\d+)[_.]/)?.[1])
      .find(Boolean) ??
      "9.9.9");

  const manifest = writeManifest(version, port);
  writeOverlay(port);

  const server = createServer((req, res) => {
    const name = decodeURIComponent((req.url ?? "/").split("?")[0].replace(/^\//, ""));
    const target = join(feedDir, name);
    // Loopback-only dev server, but keep it inside the feed dir regardless.
    if (!name || !resolve(target).startsWith(resolve(feedDir)) || !existsSync(target)) {
      res.writeHead(404).end("not found");
      console.log(`  404 ${name}`);
      return;
    }
    res.writeHead(200, {
      "content-type": MIME[extname(name).toLowerCase()] ?? "application/octet-stream",
      "content-length": statSync(target).size,
    });
    console.log(`  200 ${name}`);
    createReadStream(target).pipe(res);
  });

  server.listen(port, "127.0.0.1", () => {
    console.log("");
    console.log(`Serving ${feedDir} on http://127.0.0.1:${port}`);
    console.log(`  manifest version : ${manifest.version}`);
    console.log(`  app version      : ${readVersionFromConf()}`);
    console.log(`  platform keys    : ${Object.keys(manifest.platforms).join(", ")}`);
    console.log("");
    console.log("In another terminal:");
    console.log("  npm run tauri dev -- --config .updater-local-test/endpoint.conf.json");
    console.log("");
    console.log("Then use Settings > About > Check now. Ctrl+C to stop.");
  });
}

function cmdClean() {
  rmSync(workDir, { recursive: true, force: true });
  console.log(`updater-local-test: removed ${workDir}`);
}

const mode = process.argv[2];
if (mode === "fake") cmdFake();
else if (mode === "bundle") cmdBundle();
else if (mode === "serve") cmdServe();
else if (mode === "clean") cmdClean();
else {
  console.log(
    [
      "usage: node scripts/updater-local-test.mjs <mode>",
      "",
      "  fake   [--version 9.9.9]   sign a placeholder payload (fast loop)",
      "  bundle [--version 9.9.9]   build a real signed installer (full loop)",
      "  serve  [--port 8787]       serve the feed and write the dev overlay",
      "  clean                      remove .updater-local-test/",
    ].join("\n"),
  );
  process.exit(mode ? 1 : 0);
}
