// Chrome DevTools Protocol client for driving the Typeward webview.
// Launch the app with the debugging port exposed:
//   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
// then connect() attaches to the main window's page target. Node >= 22
// (global WebSocket) — no dependencies.

export async function listTargets(port = 9333) {
  return await (await fetch(`http://127.0.0.1:${port}/json`)).json();
}

// `match` picks the target (VS Code exposes several: workbench page, webview
// iframes, workers); default keeps the original behavior — first page target.
export async function connect(port = 9333, match) {
  const list = await listTargets(port);
  const page = list.find(match ?? ((t) => t.type === "page" && !/devtools/i.test(t.url)));
  if (!page) {
    throw new Error(`no matching target on :${port}; targets: ${list.map((t) => `${t.type}:${t.url}`).join(", ")}`);
  }
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = () => rej(new Error(`websocket connect failed: ${page.webSocketDebuggerUrl}`));
  });
  let nextId = 0;
  const pending = new Map();
  ws.onmessage = (ev) => {
    const msg = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
    const p = msg.id && pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.error) p.rej(new Error(JSON.stringify(msg.error)));
    else p.res(msg.result);
  };

  const send = (method, params = {}) =>
    new Promise((res, rej) => {
      const id = ++nextId;
      pending.set(id, { res, rej });
      ws.send(JSON.stringify({ id, method, params }));
    });

  const evaluate = async (expression) => {
    const r = await send("Runtime.evaluate", {
      expression,
      returnByValue: true,
      awaitPromise: true,
    });
    if (r.exceptionDetails) {
      throw new Error(r.exceptionDetails.exception?.description ?? JSON.stringify(r.exceptionDetails));
    }
    return r.result?.value;
  };

  /** Poll `expression` until it returns truthy or timeoutMs elapses. */
  const waitFor = async (expression, timeoutMs = 15_000, intervalMs = 200) => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const v = await evaluate(expression);
      if (v) return v;
      if (Date.now() > deadline) throw new Error(`waitFor timed out: ${expression}`);
      await new Promise((r) => setTimeout(r, intervalMs));
    }
  };

  return { send, evaluate, waitFor, close: () => ws.close(), target: page };
}
