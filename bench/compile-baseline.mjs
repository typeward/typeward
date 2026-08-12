// TeX-dependent baseline legs for the long-document plan's Phase 0: compile
// wall times and per-lookup SyncTeX CLI latency on a generated corpus variant.
//
//   node bench/generate.mjs
//   node bench/compile-baseline.mjs bench/corpus/book
//   node bench/compile-baseline.mjs bench/corpus/book --skip-cold --lookups 30
//
// Requires a TeX distro on PATH (latexmk or pdflatex+bibtex, plus synctex).
// Results print as a table and land in bench/results/ as JSON. These are the
// scripted legs; the UI-level metrics (cold open, tab switch, completion
// latency, scroll drift) need the running app and a manual protocol.

import { spawnSync } from "node:child_process";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { cpus, platform, arch } from "node:os";
import { dirname, join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import { fileURLToPath } from "node:url";

const benchDir = dirname(fileURLToPath(import.meta.url));

function parseArgs(argv) {
  const args = { dir: join(benchDir, "corpus", "book"), skipCold: false, lookups: 20 };
  const positional = [];
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--skip-cold") args.skipCold = true;
    else if (a === "--lookups") args.lookups = Number(argv[++i]);
    else if (a === "--help" || a === "-h") {
      console.log("usage: node bench/compile-baseline.mjs [corpusDir] [--skip-cold] [--lookups N]");
      process.exit(0);
    } else positional.push(a);
  }
  if (positional[0]) args.dir = resolve(positional[0]);
  return args;
}

function run(cmd, cmdArgs, cwd) {
  const t0 = performance.now();
  const r = spawnSync(cmd, cmdArgs, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, timeout: 30 * 60 * 1000 });
  const ms = performance.now() - t0;
  if (r.error) throw new Error(`${cmd} failed to spawn: ${r.error.message}`);
  return { ms, status: r.status, stdout: r.stdout ?? "", stderr: r.stderr ?? "" };
}

function toolVersion(cmd, flag = "--version") {
  const r = spawnSync(cmd, [flag], { encoding: "utf8" });
  if (r.error || r.status !== 0) return null;
  return (r.stdout || r.stderr).split("\n")[0].trim();
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

function quantile(xs, q) {
  // Nearest-rank: ceil(q*n)-1; plain floor(q*n) lands one rank too deep
  // whenever q*n is an integer (p90 of 20 samples must be the 18th, not 19th).
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.max(0, Math.min(s.length - 1, Math.ceil(q * s.length) - 1))];
}

const args = parseArgs(process.argv);
if (!Number.isSafeInteger(args.lookups) || args.lookups < 0) {
  throw new Error(`--lookups needs a non-negative integer`);
}
const root = args.dir;
const project = JSON.parse(readFileSync(join(root, ".typeward", "project.json"), "utf8"));
const rootFile = project.rootFile;
// TeX writes artifacts by JOBNAME (basename) into the cwd, so a rootFile in a
// subdirectory (lshort's src/lshort.tex) still lands lshort.{log,pdf} at root.
const jobname = rootFile.replace(/\.tex$/, "").split("/").pop();

// Mirror the app's fallback: latexmk first, raw-engine sequence when latexmk
// is present but unusable (MiKTeX without a working Perl).
const latexmkUsable = toolVersion("latexmk", "-v") !== null;
// The synctex CLI exits nonzero on `help`, so probe spawnability, not status —
// Tectonic-only machines legitimately have no synctex and skip those legs.
const synctexProbe = spawnSync("synctex", ["help"], { encoding: "utf8" });
const synctexAvailable = !synctexProbe.error;
const engines = {
  latexmk: toolVersion("latexmk", "-v"),
  pdflatex: toolVersion("pdflatex"),
  bibtex: toolVersion("bibtex"),
  synctex: synctexAvailable ? (toolVersion("synctex", "help") ?? "present") : null,
};

function compileOnce() {
  if (latexmkUsable) {
    const r = run("latexmk", ["-pdf", "-synctex=1", "-interaction=nonstopmode", rootFile], root);
    if (r.status !== 0) throw new Error(`latexmk exited ${r.status}; see ${jobname}.log`);
    return { ms: r.ms, engine: "latexmk" };
  }
  const flags = ["-synctex=1", "-interaction=nonstopmode", rootFile];
  let total = 0;
  for (const [cmd, a] of [
    ["pdflatex", flags],
    ["bibtex", [jobname]],
    ["pdflatex", flags],
    ["pdflatex", flags],
  ]) {
    const r = run(cmd, a, root);
    total += r.ms;
    if (r.status !== 0 && cmd !== "bibtex") throw new Error(`${cmd} exited ${r.status}`);
  }
  return { ms: total, engine: "pdflatex+bibtex" };
}

// No "pdf" here: a project can legitimately ship .pdf SOURCE assets
// (\includegraphics{setpage-example.pdf} in the memoir manual) — only the
// jobname's own output is safe to delete.
const ARTIFACT_EXTS = [
  "aux", "log", "out", "toc", "lof", "lot", "fls", "fdb_latexmk", "bbl", "blg",
  "bcf", "run.xml", "synctex.gz", "synctex(busy)",
];

function cleanArtifacts() {
  const walk = (dir) => {
    for (const entry of readdirSafe(dir)) {
      const p = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === ".typeward" || entry.name === ".git") continue;
        walk(p);
      } else if (ARTIFACT_EXTS.some((ext) => entry.name.endsWith(`.${ext}`))) {
        rmSync(p, { force: true });
      }
    }
  };
  walk(root);
  rmSync(join(root, `${jobname}.pdf`), { force: true });
}

import { readdirSync } from "node:fs";
function readdirSafe(dir) {
  try {
    return readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

const results = { legs: {} };

if (!args.skipCold) {
  cleanArtifacts();
  console.log("cold compile...");
  const cold = compileOnce();
  results.legs.coldCompileMs = Math.round(cold.ms);
  results.engine = cold.engine;
  console.log(`  ${Math.round(cold.ms)} ms (${cold.engine})`);
} else if (!existsSync(join(root, `${jobname}.pdf`))) {
  throw new Error("--skip-cold but no PDF exists; run a cold build first");
}

console.log("warm no-op compile...");
const warm = compileOnce();
results.legs.warmNoopCompileMs = Math.round(warm.ms);
results.engine = results.engine ?? warm.engine;
console.log(`  ${Math.round(warm.ms)} ms`);

// One-chapter edit: what recompile-after-keystroke actually costs today.
// Generated corpus only — third-party documents have no chapters/ layout.
const touchTarget = ["ch072.tex", "ch001.tex"]
  .map((f) => join(root, "chapters", f))
  .find((p) => existsSync(p));
if (touchTarget) {
  console.log("warm compile after touching one chapter...");
  const before = statSync(touchTarget);
  appendFileSync(touchTarget, "% touched by compile-baseline\n");
  try {
    const touched = compileOnce();
    results.legs.warmTouchedCompileMs = Math.round(touched.ms);
    console.log(`  ${Math.round(touched.ms)} ms`);
  } finally {
    const body = readFileSync(touchTarget, "utf8");
    writeFileSync(touchTarget, body.replace(/% touched by compile-baseline\n$/, ""));
    utimesSync(touchTarget, before.atime, before.mtime);
  }
  // Untimed settle pass: latexmk fingerprints sources by checksum, so the
  // revert alone leaves the project dirty and would poison the next run's
  // warm-no-op leg.
  console.log("settling (untimed)...");
  compileOnce();
}

const log = readFileSync(join(root, `${jobname}.log`), "latin1");
const pagesMatch = log.match(/Output written on .*\((\d+) pages?/);
results.pages = pagesMatch ? Number(pagesMatch[1]) : null;
console.log(`pages: ${results.pages ?? "unknown"}`);

// SyncTeX CLI latency: one subprocess per lookup is exactly what the app does
// today (synctex.rs), so per-invocation wall time IS the user-visible latency.
const pdf = `${jobname}.pdf`;
// .tex only: after a compile, chapters/ also holds per-chapter .aux files,
// which have no synctex tag and would poison half the lookup sample.
const chapterFiles = readdirSafe(join(root, "chapters"))
  .filter((e) => e.name.endsWith(".tex"))
  .map((e) => `chapters/${e.name}`)
  .sort();
if (!synctexAvailable) {
  console.log("synctex CLI not on PATH — skipping lookup legs");
} else if (existsSync(join(root, pdf)) && chapterFiles.length > 0) {
  // A lookup-leg failure must not discard the compile timings already
  // measured — the record still gets written below.
  try {
    const fwd = [];
    let fwdHits = 0;
    for (let i = 0; i < args.lookups; i++) {
      const file = chapterFiles[(i * 37) % chapterFiles.length];
      const line = 10 + ((i * 53) % 120);
      // Absolute source path — mirrors synctex.rs::forward; the CLI answers
      // "No tag" for project-relative names.
      const r = run("synctex", ["view", "-i", `${line}:1:${join(root, file)}`, "-o", pdf], root);
      fwd.push(r.ms);
      if (/^Page:/m.test(r.stdout)) fwdHits++;
    }
    results.legs.synctexForward = {
      lookups: args.lookups,
      hits: fwdHits,
      medianMs: Math.round(median(fwd)),
      p90Ms: Math.round(quantile(fwd, 0.9)),
    };
    console.log(`synctex forward: median ${results.legs.synctexForward.medianMs} ms, p90 ${results.legs.synctexForward.p90Ms} ms, hits ${fwdHits}/${args.lookups}`);

    const inv = [];
    let invHits = 0;
    const pages = results.pages ?? 100;
    for (let i = 0; i < args.lookups; i++) {
      const page = 1 + ((i * 61) % Math.max(1, pages));
      const r = run("synctex", ["edit", "-o", `${page}:300:400:${pdf}`], root);
      inv.push(r.ms);
      if (/^Input:/m.test(r.stdout)) invHits++;
    }
    results.legs.synctexInverse = {
      lookups: args.lookups,
      hits: invHits,
      medianMs: Math.round(median(inv)),
      p90Ms: Math.round(quantile(inv, 0.9)),
    };
    console.log(`synctex inverse: median ${results.legs.synctexInverse.medianMs} ms, p90 ${results.legs.synctexInverse.p90Ms} ms, hits ${invHits}/${args.lookups}`);
  } catch (e) {
    console.warn(`synctex legs failed: ${e.message} — compile timings still recorded`);
  }
}

const record = {
  timestamp: new Date().toISOString(),
  variant: root.split(/[\\/]/).pop(),
  machine: { platform: platform(), arch: arch(), cpu: cpus()[0]?.model ?? "unknown", cores: cpus().length },
  engines,
  ...results,
};
const outDir = join(benchDir, "results");
mkdirSync(outDir, { recursive: true });
const outPath = join(outDir, `baseline-${record.variant}-${record.timestamp.replace(/[:.]/g, "-")}.json`);
writeFileSync(outPath, JSON.stringify(record, null, 2) + "\n");
console.log(`wrote ${outPath}`);
