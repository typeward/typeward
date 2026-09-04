// Phase 3 falsification harness — the GATE for chapter-scoped (`\includeonly`)
// drafts. Ships nothing: it answers whether an `\includeonly` build, given the
// full build's complete `.aux` set, reproduces the full build's cross-
// references, `\newlabel` page numbers, and citation set for the included
// chapters. If it can't, the feature is not viable as designed and the plan's
// fallback (skip the bib pass / badge "citations renumbered") applies.
//
//   node bench/generate.mjs --variant book        # if not already generated
//   node bench/chapter-scoped-harness.mjs [ch010,ch011]
//
// Reports a pass/fail per assertion and writes the detail to bench/results/.

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));
const book = join(benchDir, "corpus", "book");
const args = process.argv.slice(2);
const subset = (args.find((a) => !a.startsWith("--")) ?? "ch010,ch011")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

if (!existsSync(join(book, "main.tex"))) {
  console.error(`corpus missing at ${book} — run: node bench/generate.mjs --variant book`);
  process.exit(1);
}

const run = (cmd, cmdArgs) =>
  execFileSync(cmd, cmdArgs, { cwd: book, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 900_000 });

/** All `\newlabel{key}{{tag}{page}...}` -> { key: page } across every .aux. */
function collectNewlabels() {
  const out = {};
  const auxFiles = [
    ...readdirSync(book).filter((f) => f.endsWith(".aux")).map((f) => join(book, f)),
    ...readdirSync(join(book, "chapters"))
      .filter((f) => f.endsWith(".aux"))
      .map((f) => join(book, "chapters", f)),
  ];
  const re = /\\newlabel\{([^}]+)\}\{\{[^}]*\}\{([^}]*)\}/g;
  for (const f of auxFiles) {
    const text = readFileSync(f, "latin1");
    let m;
    while ((m = re.exec(text)) !== null) out[m[1]] = m[2];
  }
  return out;
}

/** Citation keys used, from every .aux (`\citation{key}` / `\abx@aux@cite`). */
function collectCitations() {
  const keys = new Set();
  const auxFiles = [
    ...readdirSync(book).filter((f) => f.endsWith(".aux")).map((f) => join(book, f)),
    ...readdirSync(join(book, "chapters"))
      .filter((f) => f.endsWith(".aux"))
      .map((f) => join(book, "chapters", f)),
  ];
  const re = /\\citation\{([^}]+)\}/g;
  for (const f of auxFiles) {
    const text = readFileSync(f, "latin1");
    let m;
    while ((m = re.exec(text)) !== null) for (const k of m[1].split(",")) keys.add(k.trim());
  }
  return keys;
}

/** Count `\bibitem` entries rendered into the .bbl. */
function bblEntryCount() {
  const bbl = join(book, "main.bbl");
  if (!existsSync(bbl)) return 0;
  return (readFileSync(bbl, "latin1").match(/\\bibitem/g) ?? []).length;
}

// Which labels belong to the included chapters (their key prefix matches).
const includedLabelKey = (key) => subset.some((ch) => key.includes(ch.replace(/^ch/, "")));

console.log(`chapter-scoped harness: subset = [${subset.join(", ")}]`);

// --- Step 1: full build ----------------------------------------------------
console.log("full build (latexmk, clean)...");
for (const ext of ["aux", "bbl", "blg", "log", "out", "toc", "pdf", "fls", "fdb_latexmk", "synctex.gz"]) {
  rmSync(join(book, `main.${ext}`), { force: true });
}
rmSync(join(book, "main.tex.bak"), { force: true });
const mainTex = readFileSync(join(book, "main.tex"), "utf8");
try {
  run("latexmk", ["-pdf", "-interaction=nonstopmode", "-synctex=1", "main.tex"]);
} catch {
  /* latexmk exits non-zero on warnings; we assert on the artifacts, not exit code */
}
const fullLabels = collectNewlabels();
const fullCites = collectCitations();
const fullBbl = bblEntryCount();
console.log(`  full: ${Object.keys(fullLabels).length} labels, ${fullCites.size} cites, ${fullBbl} bib entries`);

// --- Step 2: \includeonly build over the SAME .aux set ---------------------
// Keep every .aux (excluded chapters' \@setckpt counter checkpoints are what
// make page numbers reproduce); inject \includeonly and run ONE engine pass so
// it reads the existing .aux rather than regenerating from scratch.
console.log(`\\includeonly build (subset, keeping the full .aux set)...`);
const injected = mainTex.replace(
  /\\begin\{document\}/,
  `\\includeonly{${subset.map((c) => `chapters/${c}`).join(",")}}\n\\begin{document}`,
);
writeFileSync(join(book, "main.tex"), injected, "utf8");
// TWO engine passes — the realistic draft build. Pass 1 rewrites the included
// chapters' .aux (excluded chapters are read-only, so their \@setckpt
// checkpoints survive); pass 2 resolves the forward references pass 1 could
// not yet see. We check the SECOND pass's log for undefined refs.
let includeLog = "";
for (let pass = 0; pass < 2; pass++) {
  try {
    includeLog = run("pdflatex", ["-interaction=nonstopmode", "-synctex=1", "main.tex"]);
  } catch (e) {
    includeLog = String(e.stdout ?? "") + String(e.stderr ?? "");
  }
}
// Restore the original main.tex immediately.
writeFileSync(join(book, "main.tex"), mainTex, "utf8");
const scopedLabels = collectNewlabels();

// --- Assertions ------------------------------------------------------------
const results = { subset, checks: {}, detail: {} };

// (a) zero undefined references in the \includeonly pass.
const undefinedRefs = (includeLog.match(/Reference `[^']+' on page .* undefined/g) ?? []).length;
const undefinedCites = (includeLog.match(/Citation `[^']+' on page .* undefined/g) ?? []).length;
results.checks.zeroUndefined = undefinedRefs === 0 && undefinedCites === 0;
results.detail.undefinedRefs = undefinedRefs;
results.detail.undefinedCites = undefinedCites;

// (b) \newlabel page numbers identical for the INCLUDED chapters' labels.
let pageMatch = 0;
let pageMismatch = 0;
const mismatches = [];
for (const [key, page] of Object.entries(fullLabels)) {
  if (!includedLabelKey(key)) continue;
  const scoped = scopedLabels[key];
  if (scoped === undefined) {
    pageMismatch++;
    if (mismatches.length < 10) mismatches.push(`${key}: full=${page} scoped=MISSING`);
  } else if (scoped === page) {
    pageMatch++;
  } else {
    pageMismatch++;
    if (mismatches.length < 10) mismatches.push(`${key}: full=${page} scoped=${scoped}`);
  }
}
results.checks.pageNumbersIdentical = pageMismatch === 0 && pageMatch > 0;
results.detail.pageMatch = pageMatch;
results.detail.pageMismatch = pageMismatch;
results.detail.sampleMismatches = mismatches;

// (c) citations + bib entry count unchanged (the .bbl is not rebuilt in a
// single-pass \includeonly, so it must still carry the full set).
const scopedBbl = bblEntryCount();
const scopedCites = collectCitations();
results.checks.bibEntriesIdentical = scopedBbl === fullBbl && scopedBbl > 0;
results.checks.citationsPreserved = scopedCites.size >= fullCites.size;
results.detail.fullBbl = fullBbl;
results.detail.scopedBbl = scopedBbl;
results.detail.fullCites = fullCites.size;
results.detail.scopedCites = scopedCites.size;

const allPass = Object.values(results.checks).every(Boolean);
results.verdict = allPass ? "VIABLE" : "NEEDS-FALLBACK";

console.log("\n=== assertions ===");
for (const [name, pass] of Object.entries(results.checks)) {
  console.log(`  ${pass ? "PASS" : "FAIL"}  ${name}`);
}
console.log(`\nlabel page numbers: ${pageMatch} match, ${pageMismatch} mismatch`);
if (mismatches.length) console.log("  sample mismatches:", JSON.stringify(mismatches.slice(0, 5)));
console.log(`bib entries: full=${fullBbl} scoped=${scopedBbl}; cites: full=${fullCites.size} scoped=${scopedCites.size}`);
console.log(`\nVERDICT: ${results.verdict}`);

const outDir = join(benchDir, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
writeFileSync(join(outDir, `chapter-scoped-${stamp}.json`), JSON.stringify(results, null, 2) + "\n");
process.exit(allPass ? 0 : 2);
