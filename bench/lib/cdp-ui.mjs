// UI-interaction helpers over the raw CDP connection (bench/lib/cdp.mjs).
// Clicks synthesize real mouse events at element centers via Input.dispatch*
// so delegated Solid handlers and focus behave exactly as for a user.

export function uiHelpers(c) {
  const centerOf = async (selector) => {
    const box = await c.evaluate(`(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return null;
      el.scrollIntoView({ block: "center" });
      const r = el.getBoundingClientRect();
      return { x: r.x + r.width / 2, y: r.y + r.height / 2 };
    })()`);
    if (!box) throw new Error(`no element: ${selector}`);
    return box;
  };

  const click = async (selector) => {
    const { x, y } = await centerOf(selector);
    for (const type of ["mousePressed", "mouseReleased"]) {
      await c.send("Input.dispatchMouseEvent", { type, x, y, button: "left", clickCount: 1 });
    }
  };

  const insertText = (text) => c.send("Input.insertText", { text });

  /** One full key chord through the real event pipeline (keyboard router). */
  const key = async (keyName, { ctrl = false, code = keyName, windowsVirtualKeyCode = 0 } = {}) => {
    const modifiers = ctrl ? 2 : 0;
    await c.send("Input.dispatchKeyEvent", {
      type: "rawKeyDown", key: keyName, code, modifiers, windowsVirtualKeyCode,
    });
    await c.send("Input.dispatchKeyEvent", {
      type: "keyUp", key: keyName, code, modifiers, windowsVirtualKeyCode,
    });
  };

  const perfEntries = () => c.evaluate(`window.__typewardPerf ? window.__typewardPerf.entries : null`);

  const waitForEntry = async (name, timeoutMs = 30_000, after = 0) => {
    await c.waitFor(
      `window.__typewardPerf && window.__typewardPerf.entries.some((e) => e.name === ${JSON.stringify(name)} && e.at > ${after})`,
      timeoutMs,
    );
    const entries = await perfEntries();
    return entries.filter((e) => e.name === name && e.at > after).pop();
  };

  return { centerOf, click, insertText, key, perfEntries, waitForEntry };
}
