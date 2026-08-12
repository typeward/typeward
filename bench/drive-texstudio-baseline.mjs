// Drives a throwaway portable TeXstudio through the Phase 0 UI-level legs
// using its embedded QJS macro engine and collects the timings the macros
// write. Rival-side counterpart of drive-ui-baseline.mjs.
//
//   1. Extract the portable build so texstudio.exe sits at
//      bench/third-party/texstudio/texstudio.exe
//      (release asset: texstudio-<ver>-win-portable-qt6.zip).
//   2. node bench/generate.mjs --variant book --variant chapter-50k
//   3. node bench/drive-texstudio-baseline.mjs [bench-book|bench-chapter-50k]
//      [--no-compile] [--warm-open] [--timeout-min N]
//
// Hard-won mechanics (verified in the texstudio-org/texstudio 4.9.6 source),
// do not "simplify" away:
// - Every ini key lives under [texmaker]; QSettings percent-encodes spaces
//   inside key names (Scripts\Read%20Security%20Mode). Security mode 2 =
//   allow-all, which lets the macros writeFile()/readFile() with no modal.
// - Macros load from <config>/macro/Macro_<n>.txsMacro, scanned from 0 and
//   stopping at the first missing index. formatVersion 2, type "Script":
//   "tag" is the raw JS body split into lines (no %SCRIPT header — that is
//   the v1 typed-tag form) and checkState must be 2 (Qt::Checked). A JSON
//   parse failure pops a MODAL message box and blocks the whole run.
// - ?txs-start fires from a 500 ms single-shot after the main window is
//   built; no file goes on the CLI so the macro can time app.load() itself.
// - app.load() is synchronous (root + auto-loaded children + structure scan)
//   and doubles as the tab activator when the file is already open.
// - app.runCommand("txs:///quick") is ASYNC. buildManager.endRunningCommands
//   fires after the embedded viewer's synchronous Poppler reload (pre-paint,
//   pre-raster) because the quick chain ends in txs:///view. ?after-typeset
//   never fires for compile|view chains — don't switch the trigger to it.
// - setTimeout(fn, ms) stringifies fn and evaluates its SECOND
//   space-separated token: only named global `function step() {...}`
//   declarations survive that parsing.
// - The macro's engine dies when it returns unless registerAsBackgroundScript
//   pins it; the compile legs live on that pinned engine. BUT its `pdfs`
//   global is a snapshot taken at engine start (empty — no viewer exists at
//   ?txs-start), so all PDF-viewer observation lives in a second macro on
//   ?after-command-run, which gets a fresh engine (fresh pdfs) per fire.

import { existsSync, mkdirSync, openSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { stageWork } from "./lib/stage.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));

const VARIANTS = {
  "bench-book": {
    corpus: "book",
    tabA: "chapters/ch010.tex",
    tabB: "chapters/ch020.tex",
    keystrokeFile: "chapters/ch010.tex",
    keystrokeLine: 170,
    editFile: "chapters/ch010.tex",
    editLine: 60,
  },
  "bench-chapter-50k": {
    corpus: "chapter-50k",
    tabA: "chapters/ch001.tex",
    tabB: "main.tex",
    keystrokeFile: "chapters/ch001.tex",
    keystrokeLine: 25000,
    editFile: "chapters/ch001.tex",
    editLine: 25000,
  },
};

const args = process.argv.slice(2);
const variantName = args.find((a) => !a.startsWith("--")) ?? "bench-book";
const variant = VARIANTS[variantName];
if (!variant) {
  console.error(`unknown variant ${variantName}; expected one of: ${Object.keys(VARIANTS).join(", ")}`);
  process.exit(1);
}
const doCompile = !args.includes("--no-compile");
const warmOpen = args.includes("--warm-open");
const timeoutMin = args.includes("--timeout-min") ? Number(args[args.indexOf("--timeout-min") + 1]) : 25;
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0) {
  console.error("--timeout-min expects a positive number");
  process.exit(1);
}

const txsExe = join(benchDir, "third-party", "texstudio", "texstudio.exe");
if (!existsSync(txsExe)) {
  console.error(`texstudio.exe not found at ${txsExe} — extract the win-portable-qt6 zip there first`);
  process.exit(1);
}
const corpusDir = join(benchDir, "corpus", variant.corpus);
if (!existsSync(join(corpusDir, "main.tex"))) {
  console.error(`corpus missing at ${corpusDir} — run: node bench/generate.mjs --variant ${variant.corpus}`);
  process.exit(1);
}

// Fresh work copy every run (identical bytes, no leftover artifacts) unless
// the caller wants a warm open, which needs last run's aux files AND the
// structure cache inside the retained config dir.
const workDir = join(benchDir, "third-party", "work", variantName);
const configDir = join(benchDir, "third-party", "txs-config", variantName);
if (!warmOpen) {
  stageWork(corpusDir, workDir);
  rmSync(configDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
mkdirSync(join(configDir, "macro"), { recursive: true });
// Never let a previous run's outputs leak in — the PDF probe counts its
// fires by line count, and a stale bench-out.json would mask a crash.
rmSync(join(configDir, "bench-out.json"), { force: true });
rmSync(join(configDir, "bench-pdf.jsonl"), { force: true });

const fwd = (p) => resolve(p).replaceAll("\\", "/");
const outPath = fwd(join(configDir, "bench-out.json"));
const pdfStatePath = fwd(join(configDir, "bench-pdf.jsonl"));
const abs = (rel) => fwd(join(workDir, rel));

writeFileSync(
  join(configDir, "texstudio.ini"),
  [
    "[texmaker]",
    "Update\\AutoCheck=false",
    "Startup\\CheckLatexConfiguration=false",
    "Files\\RestoreSession=false",
    "Scripts\\Read%20Security%20Mode=2",
    "Scripts\\Write%20Security%20Mode=2",
    "Tools\\Commands\\compile=txs:///latexmk",
    "Tools\\Commands\\latexmk=latexmk -pdf -synctex=1 -interaction=nonstopmode %",
    "Tools\\Commands\\quick=txs:///compile | txs:///view",
    "",
  ].join("\n"),
);

// Macro_0: the benchmark orchestrator, on ?txs-start. Interactive legs run
// synchronously; the compile chain is driven by the endRunningCommands
// signal on the background-pinned engine.
const benchScript = `
var OUT = ${JSON.stringify(outPath)};
var MAIN = ${JSON.stringify(abs("main.tex"))};
var TABA = ${JSON.stringify(abs(variant.tabA))};
var TABB = ${JSON.stringify(abs(variant.tabB))};
var KEYFILE = ${JSON.stringify(abs(variant.keystrokeFile))};
var EDITFILE = ${JSON.stringify(abs(variant.editFile))};
var KEYLINE = ${variant.keystrokeLine};
var EDITLINE = ${variant.editLine};
var DO_COMPILE = ${doCompile};
var R = { stage: "boot", startedAt: Date.now(), legs: {} };
registerAsBackgroundScript("typewardBench");
function save() { writeFile(OUT, JSON.stringify(R)); }
// One quickbuild (F5) can end as SEVERAL command chains — the cold build
// observed latexmk as one chain and the first internal-viewer open as a
// second, ~1.3 s later — so the state machine synchronizes on quiescence
// (no endRunningCommands for QUIET ms), never on fire counts. Per leg it
// records both the first chain end (compiler done) and the last (viewer
// settled).
var fires = [];
var fireBase = 0;
var tC = 0;
var phase = "idle";
var QUIET = 3500;
function onBuildEnd() { fires.push(Date.now()); R.fireLog = fires; save(); }
function quiesced() { return fires.length > fireBase && Date.now() - fires[fires.length - 1] > QUIET; }
function legRecord(name) {
  R.legs[name + "FirstChainMs"] = fires[fireBase] - tC;
  R.legs[name + "SettledMs"] = fires[fires.length - 1] - tC;
  fireBase = fires.length;
  save();
}
function tick() {
  try {
    if (phase === "cold" && quiesced()) { legRecord("compileCold"); phase = "noop"; stepNoop(); }
    else if (phase === "noop" && quiesced()) { legRecord("compileNoop"); phase = "warm"; stepWarm(); }
    else if (phase === "warm" && quiesced()) { legRecord("compileWarm"); phase = "done"; R.stage = "done"; save(); stepExit(); return; }
  } catch (e) { R.error = "tick: " + e; save(); stepExit(); return; }
  setTimeout(tick, 800);
}
// app.runCommand is a PRIVATE slot (not exposed to QJS, same as
// currentEditor). The quickbuild QAction is the user-equivalent path:
// getManagedAction is a protected Q_INVOKABLE and protected members are
// exposed (normalCompletion proves it); QAction.trigger() is a public slot.
function runQuick() { app.getManagedAction("main/tools/quickbuild").trigger(); }
function watchdog() {
  if (phase !== "done") { R.error = "watchdog: stuck in phase " + phase; R.stage = "watchdog"; save(); stepExit(); }
}
function stepCold() { app.load(MAIN); phase = "cold"; tC = Date.now(); runQuick(); }
function stepNoop() { app.load(MAIN); tC = Date.now(); runQuick(); }
function stepWarm() {
  try {
    // app.currentEditor() is a PRIVATE Q_INVOKABLE (not exposed to QJS);
    // app.load() is a public slot returning the LatexEditorView, whose
    // editor Q_PROPERTY is the live QEditor. Same pattern everywhere.
    var e2 = app.load(EDITFILE).editor;
    try { app.gotoLine(EDITLINE, EDITFILE); } catch (eGoto) {}
    var para = "The resulting estimate constrains each auxiliary component and every associated invariant, so the corresponding decomposition satisfies the stated bound for every admissible configuration of the model. ";
    var blob = "\\n\\n";
    for (var k = 0; k < 14; k++) blob += para;
    blob += "\\n\\n";
    e2.write(blob);
    app.fileSaveAll();
    tC = Date.now(); runQuick();
  } catch (e) { R.error = "stepWarm: " + e; save(); stepExit(); }
}
function stepExit() { app.fileSaveAll(); app.fileExit(); }
try {
  R.stage = "open";
  var t0 = Date.now();
  app.load(MAIN);
  R.legs.openToEditorMs = Date.now() - t0;
  save();

  var t1 = Date.now(); app.load(TABA); R.legs.openTabAMs = Date.now() - t1;
  if (TABB !== MAIN) { var t2 = Date.now(); app.load(TABB); R.legs.openTabBMs = Date.now() - t2; }

  app.load(TABB);
  var sw = [];
  for (var i = 0; i < 12; i++) {
    var f = (i % 2 === 0) ? TABA : TABB;
    var ts = Date.now(); app.load(f); sw.push(Date.now() - ts);
  }
  R.legs.tabSwitchMs = sw;
  save();

  R.stage = "keystroke";
  var kview = app.load(KEYFILE);
  var ed = kview.editor;
  try { app.gotoLine(KEYLINE, KEYFILE); } catch (eGoto2) { R.gotoLineError = "" + eGoto2; }
  var ks = [];
  for (i = 0; i < 40; i++) { var tk = Date.now(); ed.write("x"); ks.push(Date.now() - tk); }
  R.legs.keystrokeMs = ks;
  for (i = 0; i < 40; i++) ed.undo();
  save();

  R.stage = "completion";
  ed.write(" \\\\ref{");
  var tc2 = Date.now();
  try { app.normalCompletion(); R.legs.completionMs = Date.now() - tc2; }
  catch (eComp) { R.completionError = "" + eComp; }
  try { kview.closeCompleter(); } catch (eCC) {}
  ed.undo(); ed.undo(); ed.undo();
  save();

  if (DO_COMPILE) {
    R.stage = "compile";
    save();
    buildManager.endRunningCommands.connect(onBuildEnd);
    setTimeout(stepCold, 1500);
    setTimeout(tick, 3000);
    setTimeout(watchdog, 480000);
  } else {
    R.stage = "done";
    save();
    setTimeout(stepExit, 1000);
  }
} catch (e) { R.error = "main: " + e; save(); setTimeout(stepExit, 1000); }
`.trim();

// Macro_1: pure PDF-viewer observer on ?after-command-run (fresh engine per
// fire, so its pdfs snapshot is live — the background engine's is frozen
// empty). The page/pages series across fires is the scroll-behavior record:
// every Build&View ends in syncFromSource, which re-anchors the viewer to
// the editor cursor's page via SyncTeX regardless of where it was scrolled.
const pdfProbeScript = `
var PDFSTATE = ${JSON.stringify(pdfStatePath)};
var prev = "";
try { var raw = readFile(PDFSTATE); if (raw) prev = "" + raw; } catch (e) {}
var lines = prev ? prev.split("\\n").filter(function (x) { return x.length > 0; }) : [];
var rec = { fire: lines.length + 1, t: Date.now(), page: -1, pages: -1 };
try {
  if (pdfs.length > 0) {
    var w = pdfs[0].widget();
    rec.pages = w.realNumPages();
    rec.page = w.getPageIndex();
  }
} catch (e2) { rec.err = "" + e2; }
lines.push(JSON.stringify(rec));
writeFile(PDFSTATE, lines.join("\\n") + "\\n");
`.trim();

const macroJson = (name, trigger, body) =>
  JSON.stringify(
    {
      formatVersion: 2,
      name,
      type: "Script",
      tag: body.split("\n"),
      description: [""],
      abbrev: "",
      trigger,
      menu: "",
      shortcut: "",
      checkState: 2,
    },
    null,
    2,
  ) + "\n";

writeFileSync(join(configDir, "macro", "Macro_0.txsMacro"), macroJson("typeward-bench", "?txs-start", benchScript));
writeFileSync(join(configDir, "macro", "Macro_1.txsMacro"), macroJson("typeward-bench-pdf", "?after-command-run", pdfProbeScript));

const logFd = openSync(join(configDir, "texstudio.log"), "a");
console.log(`launching TeXstudio (${variantName}, compile=${doCompile}, warmOpen=${warmOpen})...`);
const child = spawn(txsExe, ["--config", resolve(configDir), "--no-session", "--start-always"], {
  stdio: ["ignore", logFd, logFd],
});

const exited = await new Promise((resolveWait) => {
  const killTimer = setTimeout(() => {
    console.error(`timeout after ${timeoutMin} min — killing TeXstudio`);
    spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
    resolveWait(false);
  }, timeoutMin * 60_000);
  child.on("exit", () => {
    clearTimeout(killTimer);
    resolveWait(true);
  });
});

const outFile = join(configDir, "bench-out.json");
if (!existsSync(outFile)) {
  console.error(`no results at ${outFile} — check ${join(configDir, "texstudio.log")}`);
  process.exit(1);
}
const results = JSON.parse(readFileSync(outFile, "utf8"));
results.variant = variantName;
results.texstudio = "4.9.6 win-portable-qt6";
results.cleanExit = exited;
const pdfFile = join(configDir, "bench-pdf.jsonl");
if (existsSync(pdfFile)) {
  results.pdfProbe = readFileSync(pdfFile, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

const median = (xs) => {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
};
console.log(`stage reached: ${results.stage}${results.error ? `  ERROR: ${results.error}` : ""}`);
console.log(`open-to-editor: ${results.legs.openToEditorMs} ms (root + auto-loaded children + structure scan)`);
console.log(`tab-switch median: ${median(results.legs.tabSwitchMs)} ms  samples: ${JSON.stringify(results.legs.tabSwitchMs)}`);
console.log(`keystroke median: ${median(results.legs.keystrokeMs)} ms  max: ${Math.max(...(results.legs.keystrokeMs ?? [0]))} ms`);
console.log(`completion (\\ref): ${results.legs.completionMs} ms`);
if (doCompile) {
  for (const leg of ["compileCold", "compileNoop", "compileWarm"]) {
    console.log(`${leg}: first chain ${results.legs[`${leg}FirstChainMs`]} ms, viewer settled ${results.legs[`${leg}SettledMs`]} ms`);
  }
  if (results.pdfProbe) console.log(`pdf probe (page anchor per chain end): ${JSON.stringify(results.pdfProbe)}`);
}

const outDir = join(benchDir, "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const finalPath = join(outDir, `texstudio-${variantName}-${stamp}.json`);
writeFileSync(finalPath, JSON.stringify(results, null, 2) + "\n");
console.log(`wrote ${finalPath}`);
