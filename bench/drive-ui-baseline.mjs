// Drives the running Typeward app through the Phase 0 UI-level legs and
// records the perf-marks it emits (src/lib/perf-marks.ts).
//
//   1. Stage a corpus project into the projects root, e.g.
//        node bench/generate.mjs --variant book
//        cp -r bench/corpus/book <projectsRoot>/bench-book   (strip artifacts)
//   2. Launch with the webview debug port (and texlab on PATH if you want
//      the LSP legs):
//        WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
//   3. node bench/drive-ui-baseline.mjs [projectName] [--switches N] [--no-compile]
//
// Hard-won mechanics, do not "simplify" away:
// - Library cards show the project.json NAME (bench-book), not the folder.
// - Element.click() reaches Solid's delegated handlers but does NOT move
//   focus; the compile chord is editor-scoped, so the editor must be focused
//   first via real Input.dispatchMouseEvent clicks on a .cm-line.
// - Tab strip entries are h-7 DIVs labelled with the project-relative path
//   ("chapters/ch010.tex"); FileTree rows are w-full BUTTONs with the bare
//   filename.
// - Coordinate clicks against the FileTree while it animates go stale;
//   always element-click tree rows, mouse-click only for focus.

import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "./lib/cdp.mjs";
import { uiHelpers } from "./lib/cdp-ui.mjs";

const args = process.argv.slice(2);
const projectName = args.find((a) => !a.startsWith("--")) ?? "bench-book";
const SWITCHES = args.includes("--switches") ? Number(args[args.indexOf("--switches") + 1]) : 10;
const doCompile = !args.includes("--no-compile");

const c = await connect();
const ui = uiHelpers(c);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const jsClickButton = (text) =>
  c.evaluate(`(() => {
    const el = [...document.querySelectorAll("button")].find((e) => e.textContent.trim() === ${JSON.stringify(text)});
    if (!el) return false;
    el.click();
    return true;
  })()`);

const tabClick = (name) =>
  c.evaluate(`(() => {
    const tab = [...document.querySelectorAll("div")].find(
      (e) => e.className.toString().includes("h-7") && e.textContent.trim() === ${JSON.stringify(name)},
    );
    if (!tab) return false;
    tab.click();
    return true;
  })()`);

const mouseClickAt = async (x, y) => {
  for (const type of ["mousePressed", "mouseReleased"]) {
    await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
  }
};

const focusEditor = async (lineIndex = 8) => {
  const box = await c.evaluate(`(() => {
    const line = document.querySelectorAll(".cm-line")[${lineIndex}] ?? document.querySelector(".cm-line");
    if (!line) return null;
    line.scrollIntoView({ block: "center" });
    const r = line.getBoundingClientRect();
    return { x: r.x + Math.max(8, r.width / 4), y: r.y + r.height / 2 };
  })()`);
  if (!box) throw new Error("no .cm-line to focus");
  await sleep(150);
  await mouseClickAt(box.x, box.y);
};

const chord = async (key, code, vk) => {
  await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key, code, windowsVirtualKeyCode: vk, modifiers: 2 });
  await c.send("Input.dispatchKeyEvent", { type: "keyUp", key, code, windowsVirtualKeyCode: vk, modifiers: 2 });
};

const results = { projectName, legs: {} };

// --- open ------------------------------------------------------------------
await c.evaluate(`location.assign("/projects")`);
await sleep(2000);
await c.waitFor(`document.body.innerText.includes(${JSON.stringify(projectName)})`, 20_000);
await c.evaluate(`(() => {
  const card = [...document.querySelectorAll("div")]
    .filter((e) => e.textContent.includes(${JSON.stringify(projectName)}) && e.textContent.length < 90)
    .sort((a, b) => a.textContent.length - b.textContent.length)[0];
  card.click();
})()`);
const open = await ui.waitForEntry("open-to-editor", 30_000);
results.legs.openToEditorMs = +open.ms.toFixed(1);
console.log("open-to-editor:", results.legs.openToEditorMs, open.detail);

// Outline populates lazily (LSP or parse); don't fail the run without it.
try {
  const outline = await ui.waitForEntry("open-to-outline", 20_000);
  results.legs.openToOutlineMs = +outline.ms.toFixed(1);
  console.log("open-to-outline:", results.legs.openToOutlineMs, outline.detail);
} catch {
  console.log("open-to-outline: not recorded (no headings in root, or no LSP)");
}

// --- tab switches ----------------------------------------------------------
await jsClickButton("chapters");
await c.waitFor(`[...document.querySelectorAll("button")].some((e) => e.textContent.trim() === "ch010.tex" || e.textContent.trim() === "ch001.tex")`, 10_000);
const chapterA = (await c.evaluate(`[...document.querySelectorAll("button")].some((e) => e.textContent.trim() === "ch010.tex")`)) ? "ch010" : "ch001";
const chapterB = chapterA === "ch010" ? "ch020" : "ch001";
for (const ch of new Set([chapterA, chapterB])) {
  await jsClickButton(`${ch}.tex`);
  await c.waitFor(`[...document.querySelectorAll("div")].some((e) => e.className.toString().includes("h-7") && e.textContent.trim() === "chapters/${ch}.tex")`, 15_000);
  await sleep(500);
}
const tabA = `chapters/${chapterA}.tex`;
const tabB = chapterA === chapterB ? "main.tex" : `chapters/${chapterB}.tex`;
const switches = [];
for (let i = 0; i < SWITCHES; i++) {
  const name = i % 2 === 0 ? tabA : tabB;
  const before = Date.now();
  if (!(await tabClick(name))) throw new Error(`tab not found: ${name}`);
  const e = await ui.waitForEntry("tab-switch-to-editor", 15_000, before - 1);
  switches.push(+e.ms.toFixed(1));
  await sleep(300);
}
results.legs.tabSwitchMs = switches;
console.log("tab-switch samples:", JSON.stringify(switches));

if (doCompile) {
  // --- compile -> visible PDF ----------------------------------------------
  await focusEditor();
  let before = Date.now();
  await chord("Enter", "Enter", 13);
  console.log("compile dispatched...");
  const doc = await ui.waitForEntry("compile-to-pdf-doc", 300_000, before);
  results.legs.compileToPdfDocMs = +doc.ms.toFixed(0);
  console.log("compile-to-pdf-doc:", results.legs.compileToPdfDocMs, doc.detail);
  const reload = await ui.waitForEntry("pdf-reload-to-doc", 15_000, before);
  results.legs.pdfReloadToDocMs = +reload.ms.toFixed(1);

  // --- first useful completion ---------------------------------------------
  try {
    await sleep(800);
    const tRef = Date.now();
    await c.send("Input.insertText", { text: " \\ref{" });
    const comp = await ui.waitForEntry("lsp.completion.first-useful", 20_000, tRef - 1);
    results.legs.completionFirstUsefulMs = +comp.ms.toFixed(1);
    results.legs.completionDetail = comp.detail;
    console.log("lsp.completion.first-useful:", results.legs.completionFirstUsefulMs, comp.detail);
  } catch {
    console.log("completion: not recorded (no LSP session?)");
  } finally {
    for (let i = 0; i < 6; i++) {
      await c.send("Input.dispatchKeyEvent", { type: "rawKeyDown", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
      await c.send("Input.dispatchKeyEvent", { type: "keyUp", key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8 });
    }
  }

  // --- scroll drift across a page-count-changing recompile ------------------
  await c.evaluate(`(() => {
    const el = [...document.querySelectorAll("*")].find(
      (e) => e.querySelector("[data-page]") && e.scrollHeight > e.clientHeight * 3,
    );
    if (el) el.scrollTop = Math.floor(el.scrollHeight * 0.6);
  })()`);
  await sleep(1000);
  await focusEditor(6);
  const para =
    "The resulting estimate constrains each auxiliary component and every " +
    "associated invariant, so the corresponding decomposition satisfies the " +
    "stated bound for every admissible configuration of the model. ";
  await c.send("Input.insertText", { text: "\n\n" + para.repeat(14) + "\n\n" });
  await sleep(400);
  before = Date.now();
  await chord("Enter", "Enter", 13);
  console.log("recompile for drift leg...");
  const warm = await ui.waitForEntry("compile-to-pdf-doc", 300_000, before);
  results.legs.warmCompileToPdfDocMs = +warm.ms.toFixed(0);
  await sleep(2500);
  const entries = await ui.perfEntries();
  const drift = entries.filter((e) => e.name === "pdf-reload-scroll-drift" && e.at > before).pop();
  if (drift) {
    results.legs.scrollDrift = { pages: drift.ms, detail: drift.detail };
    console.log("pdf-reload-scroll-drift:", drift.ms, drift.detail);
  } else {
    console.log("drift: no entry (page count unchanged — same-layout fast path taken)");
  }
}

results.entries = await ui.perfEntries();
const outDir = join(dirname(fileURLToPath(import.meta.url)), "results");
mkdirSync(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
const outPath = join(outDir, `ui-baseline-${projectName}-${stamp}.json`);
writeFileSync(outPath, JSON.stringify(results, null, 2) + "\n");
console.log(`wrote ${outPath}`);
c.close();
