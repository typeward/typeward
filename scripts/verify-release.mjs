#!/usr/bin/env node
// Smoke-tests a BUILT RELEASE BUNDLE by driving it over CDP.
//
// Why this exists: a release bundle can differ from `tauri dev` in ways no test
// and no dev session can see. Tauri rewrites the CSP of assets it serves (dev
// loads them from Vite, untouched), the frontend is minified and chunk-split in
// release only, and `windows_subsystem = "windows"` changes process behavior.
// A CSP nonce injected into `style-src` once silenced `'unsafe-inline'` and
// stripped every CodeMirror rule, so the editor shipped unstyled while every
// test passed and dev looked perfect. Reasoning about the bundle does not catch
// that class of bug; running it does.
//
// Usage (Windows / WebView2):
//   npm run verify:release
//   node scripts/verify-release.mjs --port 9340 --project "Test"
//   node scripts/verify-release.mjs --attach          # already-running app
//
// The debugger is exposed through WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS, which
// the WebView2 loader reads on its own. It does NOT need the `devtools` Cargo
// feature, so this works against exactly the binary you ship.
//
// NOTE: the typing check edits the open buffer and then undoes it. Autosave may
// still write once before the undo lands, so the script re-checks the buffer
// against its baseline and fails loudly if it could not restore it.

import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const flag = (name) => process.argv.includes(`--${name}`);

const PORT = Number(arg("port", "9340"));
const EXE = arg("exe", join(repo, "src-tauri", "target", "release", "typeward.exe"));
const PROJECT = arg("project", null);
const ATTACH = flag("attach");
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

if (process.platform !== "win32") {
  console.error(
    "verify-release currently drives WebView2 only, via " +
      "WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS. On macOS and Linux the webview " +
      "exposes its inspector differently, so run this on Windows.",
  );
  process.exit(2);
}

let child = null;
if (!ATTACH) {
  if (!existsSync(EXE)) {
    console.error(`no release binary at ${EXE}\nrun \`npm run tauri build\` first, or pass --exe`);
    process.exit(2);
  }
  child = spawn(EXE, [], {
    env: { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${PORT}` },
    stdio: "ignore",
    detached: false,
  });
  child.on("error", (e) => {
    console.error(`could not launch ${EXE}: ${e.message}`);
    process.exit(2);
  });
}

// ---- CDP plumbing ---------------------------------------------------------
// bench/lib/cdp.mjs drops protocol events (it only resolves request ids), and
// the events are the point here, so this keeps its own minimal client.

let page = null;
for (let i = 0; i < 90; i++) {
  try {
    const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
    page = list.find((t) => t.type === "page" && !/devtools/i.test(t.url));
    if (page) break;
  } catch {
    // The port is not up yet; the app is still starting.
  }
  await sleep(500);
}
if (!page) {
  console.error(`no CDP page target on :${PORT} after 45s`);
  if (child) child.kill();
  process.exit(2);
}

const ws = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((res, rej) => {
  ws.onopen = res;
  ws.onerror = () => rej(new Error("CDP websocket failed"));
});

let nextId = 0;
const pending = new Map();
const cspViolations = [];
const exceptions = [];
const consoleErrors = [];
const otherLogs = [];

ws.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (m.id) {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.rej(new Error(JSON.stringify(m.error)));
    else p.res(m.result);
    return;
  }
  if (m.method === "Runtime.exceptionThrown") {
    const d = m.params.exceptionDetails;
    exceptions.push(d.exception?.description ?? d.text);
  } else if (m.method === "Runtime.consoleAPICalled") {
    const text = (m.params.args ?? []).map((a) => a.value ?? a.description ?? "").join(" ");
    if (m.params.type === "error") consoleErrors.push(text);
    else otherLogs.push(`${m.params.type}: ${text}`);
  } else if (m.method === "Log.entryAdded") {
    const e = m.params.entry;
    if (/Content Security Policy/i.test(e.text)) cspViolations.push(e.text);
    else if (e.level === "error") consoleErrors.push(e.text);
    else otherLogs.push(`${e.level}: ${e.text}`);
  }
};

const send = (method, params = {}) =>
  new Promise((res, rej) => {
    const id = ++nextId;
    pending.set(id, { res, rej });
    ws.send(JSON.stringify({ id, method, params }));
  });

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
  }
  return r.result?.value;
};

const waitFor = async (expression, timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await evaluate(expression)) return true;
    if (Date.now() > deadline) return false;
    await sleep(250);
  }
};

// ---- checks ---------------------------------------------------------------

const results = [];
const check = (name, pass, detail) => {
  results.push({ name, pass: Boolean(pass), detail });
};

await send("Runtime.enable");
await send("Log.enable");

let exitCode = 0;
try {
  await evaluate(`location.assign("/projects")`);
  await sleep(2000);
  const listed = await waitFor(`document.body.innerText.length > 20`);
  check("projects screen renders", listed, listed ? "" : "body stayed empty");

  const opened = await evaluate(`(() => {
    const big = [...document.querySelectorAll("button,[role=button],a,div")].filter((e) => {
      const r = e.getBoundingClientRect();
      return r.width > 120 && r.height > 60;
    });
    const wanted = ${JSON.stringify(PROJECT)};
    const card = wanted
      ? big.filter((e) => e.textContent.includes(wanted)).sort((a, b) => a.textContent.length - b.textContent.length)[0]
      : big.sort((a, b) => a.textContent.length - b.textContent.length).find((e) => e.textContent.trim().length > 2);
    if (!card) return null;
    card.click();
    return card.textContent.trim().slice(0, 40);
  })()`);
  check("a project opens", opened, opened ? `opened ${JSON.stringify(opened)}` : "found no project card");

  const mounted = await waitFor(`!!document.querySelector(".cm-content")`);
  check("editor mounts", mounted, mounted ? "" : ".cm-content never appeared");
  if (!mounted) throw new Error("editor never mounted; the remaining checks would be meaningless");
  await sleep(2000);

  // The style-mod stylesheet is the single thing a style-src regression kills,
  // and it takes the whole editor with it: no wrapping, no scrolling, no theme.
  const rules = await evaluate(
    `[...document.styleSheets].some((s) => { try { return [...s.cssRules].some((r) => r.cssText.includes(".cm-content")); } catch { return false; } })`,
  );
  check("CodeMirror stylesheet applied", rules, rules ? "" : "no .cm-content rule in any stylesheet (style-src regression)");

  const ws_ = await evaluate(`getComputedStyle(document.querySelector(".cm-content")).whiteSpace`);
  check("source wraps", ws_ !== "normal", `white-space: ${ws_}`);

  const ov = await evaluate(`getComputedStyle(document.querySelector(".cm-scroller")).overflowX`);
  check("editor scrolls", ov !== "visible", `overflow-x: ${ov}`);

  const font = await evaluate(`getComputedStyle(document.querySelector(".cm-content")).fontFamily`);
  check("monospace face", /mono/i.test(font), font);

  const colors = await evaluate(`(() => {
    const spans = [...document.querySelectorAll(".cm-content span[class]")];
    return [...new Set(spans.map((e) => getComputedStyle(e).color))].length;
  })()`);
  check("syntax highlighting", colors >= 2, `${colors} distinct token colors`);

  // Both inline-style contexts, checked directly: a nonce added to style-src
  // makes 'unsafe-inline' ignored, which blocks these two and nothing else.
  const attrOk = await evaluate(`(() => {
    const d = document.createElement("div"); d.textContent = "x"; document.body.appendChild(d);
    d.setAttribute("style", "color: rgb(1, 2, 3)");
    const got = getComputedStyle(d).color; d.remove(); return got === "rgb(1, 2, 3)";
  })()`);
  check("style attributes allowed", attrOk, attrOk ? "" : "setAttribute('style') blocked by CSP");

  const elemOk = await evaluate(`(() => {
    const s = document.createElement("style"); s.textContent = ".vr-probe{color: rgb(7, 8, 9)}";
    document.head.appendChild(s);
    const d = document.createElement("div"); d.className = "vr-probe"; d.textContent = "x";
    document.body.appendChild(d);
    const got = getComputedStyle(d).color; d.remove(); s.remove(); return got === "rgb(7, 8, 9)";
  })()`);
  check("runtime <style> allowed", elemOk, elemOk ? "" : "dynamic <style> blocked by CSP (breaks style-mod)");

  // Typing: the editor can look right and still take no input.
  const baseline = await evaluate(`document.querySelector(".cm-content").textContent`);
  await evaluate(`(() => {
    const c = document.querySelector(".cm-content"); c.focus();
    const line = document.querySelectorAll(".cm-line")[0];
    const r = document.createRange(); r.selectNodeContents(line); r.collapse(false);
    const sel = getSelection(); sel.removeAllRanges(); sel.addRange(r);
  })()`);
  await sleep(300);
  const MARK = "VRPROBE";
  await send("Input.insertText", { text: MARK });
  await sleep(1000);
  const typed = await evaluate(`document.querySelector(".cm-content").textContent.includes(${JSON.stringify(MARK)})`);
  check("editor accepts input", typed, typed ? "" : "inserted text never reached the document");

  // Undo, then prove the buffer is back. Autosave may have written once.
  for (const mods of [2]) {
    await send("Input.dispatchKeyEvent", { type: "keyDown", modifiers: mods, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
    await send("Input.dispatchKeyEvent", { type: "keyUp", modifiers: mods, key: "z", code: "KeyZ", windowsVirtualKeyCode: 90 });
  }
  await sleep(1200);
  const restored = await evaluate(`document.querySelector(".cm-content").textContent`);
  check(
    "buffer restored after undo",
    restored === baseline,
    restored === baseline ? "" : `buffer still differs from baseline; check the open file for a stray "${MARK}"`,
  );

  check("no CSP violations", cspViolations.length === 0, `${cspViolations.length} violation(s)`);
  check("no uncaught exceptions", exceptions.length === 0, `${exceptions.length} exception(s)`);
} catch (e) {
  check("run completed", false, e.message);
} finally {
  const failed = results.filter((r) => !r.pass);
  const width = Math.max(...results.map((r) => r.name.length), 10);
  console.log("");
  for (const r of results) {
    console.log(`  ${r.pass ? "PASS" : "FAIL"}  ${r.name.padEnd(width)}  ${r.detail}`);
  }
  if (cspViolations.length) {
    console.log(`\nCSP violations (${cspViolations.length}), first 3:`);
    for (const v of cspViolations.slice(0, 3)) console.log(`  ${v.slice(0, 200)}`);
  }
  if (exceptions.length) {
    console.log(`\nUncaught exceptions (${exceptions.length}), first 3:`);
    for (const v of exceptions.slice(0, 3)) console.log(`  ${v.slice(0, 300)}`);
  }
  if (consoleErrors.length) {
    console.log(`\nconsole.error (${consoleErrors.length}), first 5:`);
    for (const v of consoleErrors.slice(0, 5)) console.log(`  ${v.slice(0, 200)}`);
  }
  console.log(
    `\n${failed.length ? `FAILED: ${failed.length} of ${results.length} checks` : `OK: ${results.length} checks passed`}`,
  );
  exitCode = failed.length ? 1 : 0;

  try {
    ws.close();
  } catch {
    // Already closing; the exit below is what matters.
  }
  if (child && !ATTACH) child.kill();
  process.exit(exitCode);
}
