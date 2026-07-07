// Bundle-shape guard for the editor code-split (vite.config.ts advancedChunks).
//
// The load-bearing split keeps the heavy vendors (codemirror / pdfjs / markdown)
// OUT of the boot path and hoists Rolldown/Vite runtime helpers into their own
// tiny always-loaded chunk. That grouping is matched by unversioned internal
// module-id shapes (e.g. "\0@oxc-project+runtime@x.y.z/..."), which can change
// on any bundler bump — if the regex stops matching, the helpers get folded into
// a vendor chunk and the entry statically imports that whole bundle at boot
// (this previously cost ~465 KB of pre-paint pdfjs parse). The build still
// succeeds and tests still pass, so this script converts that silent regression
// into a hard failure by inspecting the boot graph declared in dist/index.html.
//
// Robust to content-hash changes: chunks are matched by name pattern, not exact
// filename. Run after `vite build`.

import { readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join, basename } from "node:path";

const distDir = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const htmlPath = join(distDir, "index.html");

// Heavy vendors that MUST be lazy (loaded by the editor/preview, not at boot).
const HEAVY = /^(codemirror|pdfjs|markdown)-[\w-]+\.js$/;
// The dedicated runtime-helpers chunk MUST exist and be part of the boot graph.
const RUNTIME_HELPERS = /^runtime-helpers-[\w-]+\.js$/;
// Ceiling on total statically-reachable boot-path JS (raw bytes). Current boot
// path is ~155 KB; a folded-in heavy vendor (~400-600 KB each) blows past this.
const BOOT_JS_CEILING_BYTES = 400 * 1024;

const html = readFileSync(htmlPath, "utf8");

const entryMatch = html.match(
  /<script[^>]+type="module"[^>]+src="([^"]+)"/,
);
if (!entryMatch) {
  fail("could not find the entry <script type=module> in dist/index.html");
}

const preloadHrefs = [...html.matchAll(/<link[^>]+rel="modulepreload"[^>]+href="([^"]+)"/g)].map(
  (m) => m[1],
);

const bootFiles = [entryMatch[1], ...preloadHrefs]
  .map((p) => basename(p))
  .filter((f) => f.endsWith(".js"));

const problems = [];

const heavyInBoot = bootFiles.filter((f) => HEAVY.test(f));
if (heavyInBoot.length > 0) {
  problems.push(
    `heavy vendor chunk(s) reached the boot path (must stay lazy): ${heavyInBoot.join(", ")}. ` +
      `The advancedChunks split in vite.config.ts likely regressed — check the runtime-helpers group id pattern.`,
  );
}

if (!bootFiles.some((f) => RUNTIME_HELPERS.test(f))) {
  problems.push(
    `no runtime-helpers-*.js chunk in the boot graph. The runtime-helpers group in ` +
      `vite.config.ts stopped capturing Rolldown/Vite helper ids — they will fold into a ` +
      `vendor chunk and drag it into the entry.`,
  );
}

let bootBytes = 0;
for (const f of bootFiles) {
  try {
    bootBytes += statSync(join(distDir, "assets", f)).size;
  } catch {
    problems.push(`boot chunk referenced in index.html is missing on disk: ${f}`);
  }
}
if (bootBytes > BOOT_JS_CEILING_BYTES) {
  problems.push(
    `boot-path JS is ${(bootBytes / 1024).toFixed(0)} KB, over the ${(BOOT_JS_CEILING_BYTES / 1024).toFixed(0)} KB ceiling. ` +
      `A heavy vendor was likely pulled into the boot graph.`,
  );
}

if (problems.length > 0) {
  fail(problems.join("\n  - "));
}

console.log(
  `bundle-shape OK: ${bootFiles.length} boot chunks, ${(bootBytes / 1024).toFixed(0)} KB boot JS, heavy vendors lazy.`,
);

function fail(msg) {
  console.error(`bundle-shape check FAILED:\n  - ${msg}`);
  process.exit(1);
}
