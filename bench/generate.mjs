// Corpus generator CLI for the long-document benchmarks (Phase 0).
//
//   node bench/generate.mjs                     # all variants -> bench/corpus/
//   node bench/generate.mjs --variant book      # one variant
//   node bench/generate.mjs --biblatex          # biber/numeric preamble (Phase 3 harness)
//   node bench/generate.mjs --check             # generate in memory, assert structure,
//                                               # print content hashes, write nothing
//
// Output is deterministic for a given seed (default 20260803). --check proves
// PER-PROCESS determinism (double-build hash compare) plus structure; do NOT
// pin the printed hashes across machines — book-figures embeds deflateSync
// output, which is only stable for a given zlib/Node build.

import { createHash } from "node:crypto";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildVariant, VARIANTS } from "./lib/gen.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { variants: [], out: join(benchDir, "corpus"), seed: 20260803, biblatex: false, check: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--variant") args.variants.push(argv[++i]);
    else if (a === "--out") args.out = resolve(argv[++i]);
    else if (a === "--seed") {
      const s = Number(argv[++i]);
      if (!Number.isSafeInteger(s) || s < 0) throw new Error(`--seed needs a non-negative integer, got: ${argv[i]}`);
      args.seed = s >>> 0;
    } else if (a === "--biblatex") args.biblatex = true;
    else if (a === "--check") args.check = true;
    else if (a === "--help" || a === "-h") {
      console.log(`usage: node bench/generate.mjs [--variant ${VARIANTS.join("|")}] [--out DIR] [--seed N] [--biblatex] [--check]`);
      process.exit(0);
    } else throw new Error(`unknown argument: ${a}`);
  }
  if (args.variants.length === 0) args.variants = [...VARIANTS];
  return args;
}

function contentHash(files) {
  const h = createHash("sha256");
  for (const path of [...files.keys()].sort()) {
    h.update(path);
    h.update("\0");
    h.update(files.get(path));
    h.update("\0");
  }
  return h.digest("hex");
}

function assertStructure(variant, files) {
  const fail = (msg) => {
    throw new Error(`structure check failed for ${variant}: ${msg}`);
  };
  const text = (p) => {
    const f = files.get(p);
    if (f === undefined) fail(`missing ${p}`);
    return typeof f === "string" ? f : f.toString("latin1");
  };

  const project = JSON.parse(text(".typeward/project.json"));
  if (project.rootFile !== "main.tex") fail("project.json rootFile");
  const main = text("main.tex");

  for (const m of main.matchAll(/\\include\{([^}]+)\}/g)) {
    if (!files.has(`${m[1]}.tex`)) fail(`\\include target missing: ${m[1]}.tex`);
  }

  if (variant === "book" || variant === "book-figures") {
    const chapters = [...files.keys()].filter((p) => p.startsWith("chapters/")).length;
    if (chapters !== 143) fail(`expected 143 chapters, got ${chapters}`);
    const bibCount = (text("refs/references.bib").match(/^@/gm) ?? []).length;
    if (bibCount !== 10000) fail(`expected 10000 bib entries, got ${bibCount}`);
  }
  if (variant === "book-figures") {
    const pngs = [...files.keys()].filter((p) => p.startsWith("figures/"));
    if (pngs.length !== 150) fail(`expected 150 figures, got ${pngs.length}`);
    for (const p of pngs) {
      const buf = files.get(p);
      if (buf[0] !== 0x89 || buf[1] !== 0x50) fail(`${p} is not a PNG`);
    }
    if (!/\\includegraphics/.test(text("chapters/ch001.tex"))) fail("figure variant has no includegraphics");
  }
  if (variant === "chapter-50k") {
    const chapter = text("chapters/ch001.tex");
    const lineCount = chapter.trimEnd().split("\n").length;
    if (lineCount !== 50000) fail(`expected 50000 lines, got ${lineCount}`);
    for (const env of ["equation"]) {
      const begins = (chapter.match(new RegExp(`\\\\begin\\{${env}\\}`, "g")) ?? []).length;
      const ends = (chapter.match(new RegExp(`\\\\end\\{${env}\\}`, "g")) ?? []).length;
      if (begins !== ends) fail(`unbalanced ${env}: ${begins} begin / ${ends} end`);
    }
    // A truncated \emph{/\textbf{ or $...$ stops the compile (seed-dependent
    // generator bug class) — brace and math-dollar balance catches it.
    const opens = (chapter.match(/\{/g) ?? []).length;
    const closes = (chapter.match(/\}/g) ?? []).length;
    if (opens !== closes) fail(`unbalanced braces: ${opens} open / ${closes} close`);
    const dollars = (chapter.match(/\$/g) ?? []).length;
    if (dollars % 2 !== 0) fail(`odd number of $ delimiters: ${dollars}`);
  }
}

const args = parseArgs(process.argv);
for (const variant of args.variants) {
  const files = buildVariant(variant, { seed: args.seed, biblatex: args.biblatex });
  assertStructure(variant, files);
  const hash = contentHash(files);
  let bytes = 0;
  for (const f of files.values()) bytes += typeof f === "string" ? Buffer.byteLength(f) : f.length;

  if (args.check) {
    // Determinism is the property CI needs (assertable corpus identity), so
    // prove it directly: a second build from scratch must byte-match.
    const again = contentHash(buildVariant(variant, { seed: args.seed, biblatex: args.biblatex }));
    if (again !== hash) throw new Error(`${variant}: non-deterministic generation (${hash} vs ${again})`);
    console.log(`${variant}: OK  files=${files.size}  bytes=${bytes}  sha256=${hash}`);
    continue;
  }

  // chapter-50k has no bibliography variant — buildVariant ignores the flag
  // there, so suffixing its directory would mislabel identical content.
  const suffixed = args.biblatex && variant.startsWith("book");
  const dir = join(args.out, suffixed ? `${variant}-biblatex` : variant);
  // Windows: retry — an AV scan or a shell parked in the dir EPERMs the rmdir.
  rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  for (const [rel, content] of files) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  console.log(`${variant}: wrote ${files.size} files (${(bytes / 1e6).toFixed(1)} MB) to ${dir}  sha256=${hash}`);
}
