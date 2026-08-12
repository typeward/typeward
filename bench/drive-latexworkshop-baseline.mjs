// Drives VS Code + LaTeX Workshop through the Phase 0 UI-level legs in a
// fully isolated profile and collects timings from in-renderer
// instrumentation. Rival-side counterpart of drive-texstudio-baseline.mjs.
//
//   1. code --user-data-dir bench/third-party/vscode/data \
//           --extensions-dir bench/third-party/vscode/ext \
//           --install-extension james-yu.latex-workshop     (one-time)
//   2. node bench/generate.mjs --variant book --variant chapter-50k
//   3. node bench/drive-latexworkshop-baseline.mjs [bench-book|bench-chapter-50k]
//      [--no-compile] [--warm-open] [--timeout-min N] [--port N]
//
// Hard-won mechanics (verified against VS Code 1.132.1 + LaTeX Workshop
// 10.17.1 source and a live CDP probe), do not "simplify" away:
// - Spawn Code.exe DIRECTLY (not the code.cmd shim) from this long-lived
//   process: the shim exits immediately and Windows job-object cleanup kills
//   the detached app. A fresh --user-data-dir is also what defeats the
//   single-instance forwarding that would otherwise swallow
//   --remote-debugging-port.
// - Targets on /json: workbench = type "page" with /workbench/workbench.html
//   (electron-browser vs electron-sandbox path varies by version — match the
//   suffix); the pdf.js viewer = type "iframe" with /viewer.html?file=pdf..
//   (it is an OOPIF two levels down: vscode-webview wrapper -> http iframe).
// - window.PDFViewerApplication is a real global inside the viewer target;
//   eventBus 'pagesloaded' is the "viewer has the new document" endpoint
//   (same pre-raster semantics as Typeward's compile-to-pdf-doc and
//   TeXstudio's ?after-command-run).
// - LaTeX Workshop has NO "Build took N ms" log line (the wiki protocol note
//   was stale). Build progress is watched via its status bar item
//   (id "James-Yu.latex-workshop": codicon-sync spinner while building) with
//   the output PDF's mtime as fallback.
// - latex-workshop.latex.autoBuild.run DEFAULTS to "onFileChange" — pin it
//   to "never" or the file watcher compiles behind the editor legs.
// - The first build synchronously probes `pdflatex --version` for MiKTeX
//   (option.maxPrintLine.enabled default true) — one-time cost inside the
//   cold-build number, part of the honest out-of-box experience.
// - Monaco's focused input receiver on current stable is .native-edit-context
//   (EditContext API), not the legacy textarea. Keystrokes are timed from a
//   capture-phase keydown listener to the first .view-lines mutation.
// - Ctrl+Alt+B's keybinding gates on editorLangId — a real mouse click into
//   the editor first (Element.click() does not move focus).

import { existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn, spawnSync } from "node:child_process";
import { connect, listTargets } from "./lib/cdp.mjs";
import { stageWork } from "./lib/stage.mjs";

const benchDir = dirname(fileURLToPath(import.meta.url));

const VARIANTS = {
  "bench-book": {
    corpus: "book",
    tabA: "ch010.tex",
    tabB: "ch020.tex",
    keystrokeTab: "ch010.tex",
    keystrokeLine: 170,
    editTab: "ch010.tex",
    editLine: 60,
  },
  "bench-chapter-50k": {
    corpus: "chapter-50k",
    tabA: "ch001.tex",
    tabB: "main.tex",
    keystrokeTab: "ch001.tex",
    keystrokeLine: 25000,
    editTab: "ch001.tex",
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
const timeoutMin = args.includes("--timeout-min") ? Number(args[args.indexOf("--timeout-min") + 1]) : 20;
const port = args.includes("--port") ? Number(args[args.indexOf("--port") + 1]) : 9223;
if (!Number.isFinite(timeoutMin) || timeoutMin <= 0 || !Number.isFinite(port)) {
  console.error("--timeout-min and --port expect numbers");
  process.exit(1);
}

const codeExe = join(process.env.LOCALAPPDATA ?? "", "Programs", "Microsoft VS Code", "Code.exe");
if (!existsSync(codeExe)) {
  console.error(`Code.exe not found at ${codeExe}`);
  process.exit(1);
}
const extDir = join(benchDir, "third-party", "vscode", "ext");
const lwInstall = existsSync(extDir) && readdirSync(extDir).find((d) => d.startsWith("james-yu.latex-workshop-"));
if (!lwInstall) {
  console.error(`LaTeX Workshop not installed in ${extDir} — run the --install-extension step from the header`);
  process.exit(1);
}
const dataDir = join(benchDir, "third-party", "vscode", "data-run");
const workDir = join(benchDir, "third-party", "work", variantName);
const corpusDir = join(benchDir, "corpus", variant.corpus);

console.log(`pre-flight: checking port ${port}...`);
try {
  await (await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(2_000) })).json();
  console.error(`port ${port} already serves CDP — a previous VS Code is still running; kill it or pass --port`);
  process.exit(1);
} catch {
  /* port free — expected */
}

if (!warmOpen) {
  stageWork(corpusDir, workDir);
  rmSync(dataDir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
}
mkdirSync(join(dataDir, "User"), { recursive: true });
writeFileSync(
  join(dataDir, "User", "settings.json"),
  JSON.stringify(
    {
      "update.mode": "none",
      "update.showReleaseNotes": false,
      "telemetry.telemetryLevel": "off",
      "workbench.startupEditor": "none",
      "security.workspace.trust.enabled": false,
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "workbench.enableExperiments": false,
      "extensions.ignoreRecommendations": true,
      "workbench.welcomePage.walkthroughs.openOnInstall": false,
      "window.restoreWindows": "none",
      "latex-workshop.latex.autoBuild.run": "never",
      "latex-workshop.message.log.show": true,
      "latex-workshop.intellisense.update.aggressive.enabled": false,
      "latex-workshop.linting.chktex.enabled": false,
    },
    null,
    2,
  ),
);

const mainAbs = resolve(join(workDir, "main.tex"));
// NEVER spawn Code.exe for --version: the bare exe is not the CLI shim, so
// that launches a full VS Code against the DEFAULT profile and blocks.
const vscodeVersion = (() => {
  try {
    return JSON.parse(readFileSync(join(dirname(codeExe), "resources", "app", "package.json"), "utf8")).version;
  } catch {
    return "unknown";
  }
})();
const results = {
  variant: variantName,
  vscode: vscodeVersion,
  latexWorkshop: lwInstall.replace("james-yu.latex-workshop-", ""),
  legs: {},
};

const logFd = openSync(join(benchDir, "third-party", "vscode", "vscode.log"), "a");
console.log(`launching VS Code (${variantName}, compile=${doCompile}, warmOpen=${warmOpen})...`);
const tSpawn = Date.now();
const child = spawn(
  codeExe,
  [
    `--remote-debugging-port=${port}`,
    "--user-data-dir", dataDir,
    "--extensions-dir", extDir,
    "--disable-workspace-trust", "--skip-welcome", "--skip-release-notes",
    "--disable-telemetry", "--disable-updates", "--disable-experiments",
    "--new-window", resolve(workDir), "--goto", mainAbs,
  ],
  { stdio: ["ignore", logFd, logFd] },
);
const killAll = () => spawnSync("taskkill", ["/T", "/F", "/PID", String(child.pid)], { stdio: "ignore" });
const hardTimeout = setTimeout(() => {
  finish(new Error(`timeout after ${timeoutMin} min — killing VS Code`));
  process.exit(1);
}, timeoutMin * 60_000);

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isWorkbench = (t) => t.type === "page" && t.url.includes("/workbench/workbench.html");
const isPdfViewer = (t) => t.type === "iframe" && t.url.includes("/viewer.html?file=pdf..");

// Always kill the spawned VS Code and persist whatever was measured — a
// thrown leg must not leave a window open or the partial numbers unrecorded.
let finished = false;
const finish = (error) => {
  if (finished) return;
  finished = true;
  if (error) {
    results.error = String(error?.stack ?? error);
    console.error(results.error);
    process.exitCode = 1;
  }
  clearTimeout(hardTimeout);
  killAll();
  results.legs.tabSwitchMedianMs = median(results.legs.tabSwitchMs);
  results.legs.keystrokeMedianMs = median(results.legs.keystrokeMs);
  const outDir = join(benchDir, "results");
  mkdirSync(outDir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outPath = join(outDir, `latexworkshop-${variantName}-${stamp}.json`);
  writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
  console.log(`wrote ${outPath}`);
};
process.on("uncaughtException", (e) => {
  finish(e);
  process.exit(1);
});
process.on("unhandledRejection", (e) => {
  finish(e);
  process.exit(1);
});

let wb = null;
for (const deadline = Date.now() + 60_000; Date.now() < deadline && !wb; ) {
  try {
    wb = await connect(port, isWorkbench);
  } catch {
    await sleep(100);
  }
}
if (!wb) {
  killAll();
  throw new Error("workbench target never appeared");
}

const key = async (k, code, vk, modifiers = 0, client = wb) => {
  const base = { key: k, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk, modifiers };
  await client.send("Input.dispatchKeyEvent", { type: "rawKeyDown", ...base });
  await client.send("Input.dispatchKeyEvent", { type: "keyUp", ...base });
};
const typeChar = async (ch) => {
  await wb.send("Input.dispatchKeyEvent", { type: "keyDown", key: ch, text: ch, unmodifiedText: ch });
  await wb.send("Input.dispatchKeyEvent", { type: "keyUp", key: ch });
};
const mouseClickAt = async (x, y) => {
  await wb.send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 });
  await wb.send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 });
};
const focusEditor = async (lineIndex = 4) => {
  const box = await wb.evaluate(`(() => {
    const ls = document.querySelectorAll('.editor-instance .view-lines .view-line');
    const line = ls[${lineIndex}] ?? ls[0];
    if (!line) return null;
    const r = line.getBoundingClientRect();
    return { x: r.x + Math.min(80, Math.max(8, r.width / 4)), y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error("no .view-line to focus");
  await mouseClickAt(box.x, box.y);
  await sleep(120);
};
const gotoLine = async (line) => {
  await key("g", "KeyG", 71, 2);
  await sleep(250);
  await wb.send("Input.insertText", { text: String(line) });
  await sleep(250);
  await key("Enter", "Enter", 13, 0);
  await sleep(300);
};
const activeTab = () =>
  wb.evaluate(`document.querySelector('.tabs-container .tab.active')?.getAttribute('data-resource-name') ?? ''`);
const quickOpen = async (name) => {
  await key("p", "KeyP", 80, 2);
  await wb.waitFor(`!!document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').style.display !== 'none'`, 8_000, 50);
  await wb.send("Input.insertText", { text: name });
  // The cold file index can take seconds on first use — never press Enter
  // until a row actually matches, or it accepts nothing.
  await wb.waitFor(
    `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some((r) => (r.textContent ?? '').includes(${JSON.stringify(name)}))`,
    20_000,
    100,
  );
  await sleep(150);
  await key("Enter", "Enter", 13, 0);
  await wb.waitFor(`document.querySelector('.tabs-container .tab.active')?.getAttribute('data-resource-name') === ${JSON.stringify(name)}`, 20_000, 50);
  await sleep(300);
};
// In-page measured switch to an already-open tab: click -> first moment the
// target tab is active AND the editor shows lines. Pre-paint, like the
// Typeward and TeXstudio legs.
const tabSwitch = (name) =>
  wb.evaluate(`(async () => {
    const want = ${JSON.stringify(name)};
    const tab = [...document.querySelectorAll('.tabs-container .tab')].find((t) => t.getAttribute('data-resource-name') === want);
    if (!tab) throw new Error('tab not found: ' + want);
    const t0 = performance.now();
    tab.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
    tab.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    tab.click();
    await new Promise((res, rej) => {
      const timer = setTimeout(() => { mo.disconnect(); rej(new Error('switch timeout: ' + want)); }, 10000);
      const check = () => {
        const a = document.querySelector('.tabs-container .tab.active');
        if (a && a.getAttribute('data-resource-name') === want && document.querySelector('.editor-instance .view-lines .view-line')) {
          clearTimeout(timer); mo.disconnect(); res();
        }
      };
      const mo = new MutationObserver(check);
      mo.observe(document.body, { subtree: true, childList: true, attributes: true });
      check();
    });
    return performance.now() - t0;
  })()`);

// --- open ------------------------------------------------------------------
try {
  await wb.waitFor(`document.querySelector('.tabs-container .tab.active')?.getAttribute('data-resource-name') === 'main.tex' && !!document.querySelector('.editor-instance .view-lines .view-line')`, 30_000, 50);
} catch {
  results.openFallback = true;
  await quickOpen("main.tex");
}
results.legs.openToEditorMs = Date.now() - tSpawn;
console.log(`open-to-editor: ${results.legs.openToEditorMs} ms (includes VS Code app boot)`);
results.startupMarks = await wb.evaluate(`performance.getEntriesByType('mark').map((m) => ({ n: m.name, t: Math.round(m.startTime) }))`);

// Outline: activity-bar icons expose EMPTY aria-labels on current stable, so
// the reliable route is the auto-generated per-view command in the palette
// ("LaTeX: Focus on Structure View"). The command only exists once the
// extension activates, and an OPEN palette never re-filters a typed query
// when commands register later — so retry by reopening and retyping.
let outlineClicked = false;
for (let attempt = 0; attempt < 10 && !outlineClicked; attempt++) {
  try {
    await key("p", "KeyP", 80, 10); // Ctrl+Shift+P
    await wb.waitFor(`!!document.querySelector('.quick-input-widget') && document.querySelector('.quick-input-widget').style.display !== 'none'`, 8_000, 50);
    await wb.send("Input.insertText", { text: "Focus on Structure" });
    await wb.waitFor(
      `[...document.querySelectorAll('.quick-input-widget .monaco-list-row')].some((r) => /focus on structure/i.test(r.textContent ?? ''))`,
      3_000,
      150,
    );
    await sleep(150);
    await key("Enter", "Enter", 13, 0);
    outlineClicked = true;
  } catch {
    await key("Escape", "Escape", 27, 0);
    await sleep(800);
  }
}
if (outlineClicked) {
  try {
    await wb.waitFor(`document.querySelectorAll('.sidebar .monaco-list-row').length > 3`, 120_000, 100);
    results.legs.openToOutlineMs = Date.now() - tSpawn;
    console.log(`open-to-outline: ${results.legs.openToOutlineMs} ms (LW structure tree populated)`);
  } catch {
    console.log("open-to-outline: tree never populated");
  }
} else {
  console.log("open-to-outline: LaTeX activity bar item not found");
}

// --- tabs ------------------------------------------------------------------
for (const name of new Set([variant.tabA, variant.tabB])) {
  if (name !== "main.tex") await quickOpen(name);
}
await tabSwitch(variant.tabB);
const switches = [];
for (let i = 0; i < 12; i++) {
  switches.push(+(await tabSwitch(i % 2 === 0 ? variant.tabA : variant.tabB)).toFixed(1));
  await sleep(250);
}
results.legs.tabSwitchMs = switches;
console.log(`tab-switch samples: ${JSON.stringify(switches)}`);

// --- keystrokes ------------------------------------------------------------
await tabSwitch(variant.keystrokeTab);
await focusEditor();
await gotoLine(variant.keystrokeLine);
await wb.evaluate(`(() => {
  window.__twBench = { ks: [], t0: 0, sug: null, sugT0: 0 };
  const lines = document.querySelector('.editor-instance .view-lines');
  document.addEventListener('keydown', () => { window.__twBench.t0 = performance.now(); }, { capture: true });
  new MutationObserver(() => {
    if (window.__twBench.t0) { window.__twBench.ks.push(performance.now() - window.__twBench.t0); window.__twBench.t0 = 0; }
  }).observe(lines, { subtree: true, childList: true, characterData: true });
  new MutationObserver(() => {
    if (window.__twBench.sugT0 && window.__twBench.sug === null && document.querySelector('.suggest-widget.visible .monaco-list-row')) {
      window.__twBench.sug = performance.now() - window.__twBench.sugT0;
      window.__twBench.sugRows = [...document.querySelectorAll('.suggest-widget.visible .monaco-list-row')].map((r) => (r.textContent ?? '').slice(0, 40));
    }
  }).observe(document.body, { subtree: true, childList: true, attributes: true });
  return true;
})()`);
for (let i = 0; i < 40; i++) {
  await typeChar("x");
  await sleep(80);
}
results.legs.keystrokeMs = ((await wb.evaluate(`window.__twBench.ks`)) ?? []).map((v) => +v.toFixed(2));
console.log(
  results.legs.keystrokeMs.length
    ? `keystroke samples (${results.legs.keystrokeMs.length}): median ${median(results.legs.keystrokeMs)} ms, max ${Math.max(...results.legs.keystrokeMs).toFixed(1)} ms`
    : "keystroke: no samples recorded (keydown listener never fired?)",
);

// --- completion --------------------------------------------------------------
for (const ch of [" ", "\\", "r", "e", "f"]) {
  await typeChar(ch);
  await sleep(60);
}
// Typing \ref pops the COMMAND-snippet suggest; dismiss it so the '{' leg
// measures the fresh LABEL completion, not the stale widget re-filtering.
await key("Escape", "Escape", 27, 0);
await sleep(300);
await wb.evaluate(`(window.__twBench.sug = null, window.__twBench.sugRows = null, window.__twBench.sugT0 = performance.now(), true)`);
await typeChar("{");
let sug = null;
try {
  sug = await wb.waitFor(`window.__twBench.sug`, 4_000, 50);
  results.legs.completionTrigger = "auto";
} catch {
  await wb.evaluate(`(window.__twBench.sug = null, window.__twBench.sugT0 = performance.now(), true)`);
  await key(" ", "Space", 32, 2);
  try {
    sug = await wb.waitFor(`window.__twBench.sug`, 15_000, 50);
    results.legs.completionTrigger = "ctrl+space";
  } catch {
    console.log("completion: suggest widget never appeared");
  }
}
if (sug !== null) {
  results.legs.completionMs = +(+sug).toFixed(1);
  results.legs.completionRows = await wb.evaluate(`window.__twBench.sugRows ?? []`);
  console.log(`completion (\\ref): ${results.legs.completionMs} ms (${results.legs.completionTrigger}), rows: ${JSON.stringify(results.legs.completionRows.slice(0, 4))}`);
}
await key("Escape", "Escape", 27, 0);
for (let i = 0; i < 60; i++) {
  await key("z", "KeyZ", 90, 2);
  await sleep(25);
}
results.dirtyAfterUndo = await wb.evaluate(`document.querySelector('.tabs-container .tab.active')?.classList.contains('dirty') ?? null`);

// --- builds ------------------------------------------------------------------
if (doCompile) {
  const statusHtml = () => wb.evaluate(`document.querySelector('[id="James-Yu.latex-workshop"]')?.innerHTML ?? ''`);
  const pdfPath = join(workDir, "main.pdf");
  const pdfMtime = () => {
    try {
      return statSync(pdfPath).mtimeMs;
    } catch {
      return 0;
    }
  };
  const waitBuildDone = async (t0, timeoutMs = 480_000) => {
    let sawBusy = false;
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const html = await statusHtml();
      const busy = /codicon-(sync|loading)/.test(html);
      if (busy) sawBusy = true;
      if (sawBusy && !busy) return { ms: Date.now() - t0, via: "statusbar" };
      if (!sawBusy && pdfMtime() > t0 && Date.now() - pdfMtime() > 2_500) return { ms: pdfMtime() - t0, via: "pdf-mtime" };
      if (Date.now() > deadline) throw new Error("build timeout");
      await sleep(150);
    }
  };

  await tabSwitch("main.tex");
  await focusEditor();
  let t0 = Date.now();
  await key("b", "KeyB", 66, 3); // Ctrl+Alt = 3
  console.log("cold build dispatched...");
  const cold = await waitBuildDone(t0);
  results.legs.coldBuildMs = cold.ms;
  results.legs.coldBuildVia = cold.via;
  console.log(`cold build: ${cold.ms} ms (${cold.via})`);

  // First viewer open (the cold compile-to-visible composes with this).
  await focusEditor();
  t0 = Date.now();
  await key("v", "KeyV", 86, 3);
  let pv = null;
  for (const deadline = Date.now() + 30_000; Date.now() < deadline && !pv; ) {
    try {
      if ((await listTargets(port)).some(isPdfViewer)) pv = await connect(port, isPdfViewer);
    } catch {
      /* retry */
    }
    if (!pv) await sleep(100);
  }
  if (!pv) throw new Error("pdf viewer target never appeared");
  await pv.waitFor(`!!window.PDFViewerApplication && PDFViewerApplication.pagesCount > 0`, 30_000, 50);
  results.legs.firstViewMs = Date.now() - t0;
  console.log(`first viewer open: ${results.legs.firstViewMs} ms, pages=${await pv.evaluate(`PDFViewerApplication.pagesCount`)}`);
  await pv.evaluate(`(async () => {
    if (window.__twBench) return true;
    window.__twBench = { events: [] };
    await PDFViewerApplication.initializedPromise;
    ['documentloaded', 'pagesinit', 'pagesloaded'].forEach((n) =>
      PDFViewerApplication.eventBus.on(n, () => {
        const c = document.getElementById('viewerContainer');
        window.__twBench.events.push({ n, t: Date.now(), page: PDFViewerApplication.pdfViewer.currentPageNumber, scrollTop: c ? Math.round(c.scrollTop) : -1, pages: PDFViewerApplication.pagesCount });
      }));
    return true;
  })()`);

  await tabSwitch("main.tex");
  await focusEditor();
  t0 = Date.now();
  await key("b", "KeyB", 66, 3);
  console.log("no-op build dispatched...");
  const noop = await waitBuildDone(t0);
  results.legs.noopBuildMs = noop.ms;
  await sleep(3_000);
  results.legs.noopRefreshedViewer = (await pv.evaluate(`window.__twBench.events`)).some((e) => e.n === "pagesloaded" && e.t > t0);
  console.log(`no-op build: ${noop.ms} ms (viewer refreshed: ${results.legs.noopRefreshedViewer})`);

  // Warm page-shifting edit; viewer scrolled away first so the restore
  // behavior across the refresh is observable.
  results.legs.pdfBefore = await pv.evaluate(`(() => {
    const c = document.getElementById('viewerContainer');
    c.scrollTop = Math.floor(c.scrollHeight * 0.6);
    return { scrollTop: Math.round(c.scrollTop), page: PDFViewerApplication.pdfViewer.currentPageNumber, pages: PDFViewerApplication.pagesCount };
  })()`);
  await tabSwitch(variant.editTab);
  await focusEditor();
  await gotoLine(variant.editLine);
  const para =
    "The resulting estimate constrains each auxiliary component and every " +
    "associated invariant, so the corresponding decomposition satisfies the " +
    "stated bound for every admissible configuration of the model. ";
  await wb.send("Input.insertText", { text: "\n\n" + para.repeat(14) + "\n\n" });
  await sleep(400);
  t0 = Date.now();
  await key("b", "KeyB", 66, 3);
  console.log("warm build dispatched...");
  const warm = await waitBuildDone(t0);
  results.legs.warmBuildMs = warm.ms;
  const ev = await pv
    .waitFor(
      `(() => { const es = window.__twBench.events.filter((e) => e.n === 'pagesloaded' && e.t > ${t0}); return es.length ? JSON.stringify(es) : false; })()`,
      60_000,
      100,
    )
    .then((s) => JSON.parse(s)[0])
    .catch(() => null);
  if (ev) results.legs.warmVisibleMs = ev.t - t0;
  await sleep(2_000);
  results.legs.pdfAfter = await pv.evaluate(`(() => {
    const c = document.getElementById('viewerContainer');
    return { scrollTop: Math.round(c.scrollTop), page: PDFViewerApplication.pdfViewer.currentPageNumber, pages: PDFViewerApplication.pagesCount };
  })()`);
  results.viewerEvents = await pv.evaluate(`window.__twBench.events`);
  console.log(`warm build: ${warm.ms} ms, viewer visible at ${results.legs.warmVisibleMs ?? "n/a"} ms`);
  console.log(`scroll: before ${JSON.stringify(results.legs.pdfBefore)} after ${JSON.stringify(results.legs.pdfAfter)}`);
  pv.close();
}

finish();

function median(xs) {
  if (!xs?.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return +s[Math.floor(s.length / 2)].toFixed(1);
}
