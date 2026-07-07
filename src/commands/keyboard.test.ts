import { afterEach, describe, expect, it, vi } from "vitest";
import type { EditorCommand } from "~/adapters/types";

// keyboard.ts -> run.ts -> ~/lib/toast pulls in the Kobalte toast stack. Keep
// it out of these unit tests; dispatchCommand only calls notifyError on a
// rejection, which none of these fakes trigger.
vi.mock("~/lib/toast", () => ({
  notifyError: vi.fn(),
  notifySuccess: vi.fn(),
  notifyInfo: vi.fn(),
}));

import { handleKeydown } from "./keyboard";

// jsdom reports a non-Mac platform (Win32), so shortcuts.isMac === false and
// "Mod" resolves to Ctrl. The Mac branch of matches() is covered in
// shortcuts.test.ts; here we assert the router composes the non-Mac mapping.

const makeCmd = (over: Partial<EditorCommand>): EditorCommand => ({
  id: "test.cmd",
  title: "Test command",
  run: vi.fn(),
  ...over,
});

/**
 * Build a keydown event and pin its `target` to a specific element. A freshly
 * constructed KeyboardEvent has target === null until dispatched; we shadow the
 * prototype getter so handleKeydown sees the focus context we want.
 */
const keyEvent = (
  init: KeyboardEventInit,
  target: EventTarget | null,
): KeyboardEvent => {
  const evt = new KeyboardEvent("keydown", { cancelable: true, ...init });
  Object.defineProperty(evt, "target", { value: target, configurable: true });
  return evt;
};

const el = (tag: string, attrs: Record<string, string> = {}): HTMLElement => {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === "class") node.className = v;
    else node.setAttribute(k, v);
  }
  document.body.append(node);
  return node;
};

const childOf = (parent: HTMLElement, tag = "div"): HTMLElement => {
  const child = document.createElement(tag);
  parent.append(child);
  return child;
};

afterEach(() => {
  document.body.replaceChildren();
  vi.clearAllMocks();
});

describe("handleKeydown — Mod token / platform mapping", () => {
  it("fires a global Mod+K command on Ctrl+K (non-Mac Mod = Ctrl)", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+K", scope: "global", run });
    const evt = keyEvent({ key: "k", ctrlKey: true }, document.body);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("does not fire Mod+K on Meta+K on a non-Mac platform", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+K", scope: "global", run });
    const evt = keyEvent({ key: "k", metaKey: true }, document.body);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
    // No app command owns the key here, so the native default is left intact.
    expect(evt.defaultPrevented).toBe(false);
  });

  it("does not fire Mod+K on a bare K with no modifier", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+K", scope: "global", run });
    const evt = keyEvent({ key: "k" }, document.body);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
  });
});

describe("handleKeydown — editor scope gating", () => {
  it("does not fire an editor-scoped command from a Settings input", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+S", scope: "editor", run });
    const input = el("input");
    const evt = keyEvent({ key: "s", ctrlKey: true }, input);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
  });

  it("fires an editor-scoped command from inside [data-editor-shell]", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+S", scope: "editor", run });
    const shell = el("div", { "data-editor-shell": "" });
    const target = childOf(shell);
    const evt = keyEvent({ key: "s", ctrlKey: true }, target);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("fires an editor-scoped command from inside .cm-content", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+S", scope: "editor", run });
    const cm = el("div", { class: "cm-content" });
    const target = childOf(cm);
    const evt = keyEvent({ key: "s", ctrlKey: true }, target);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires via the document.activeElement fallback when the target is body", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+S", scope: "editor", run });
    const shell = el("div", { "data-editor-shell": "" });
    const focusable = childOf(shell, "button");
    focusable.tabIndex = 0;
    focusable.focus();
    expect(document.activeElement).toBe(focusable);

    // Key hits the body (no input focused) right after an editor click.
    const evt = keyEvent({ key: "s", ctrlKey: true }, document.body);
    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("fires a global command regardless of focus context", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+K", scope: "global", run });
    const target = childOf(el("div"));
    const evt = keyEvent({ key: "k", ctrlKey: true }, target);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
  });

  it("defaults an omitted scope to global (fires without editor focus)", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+B", run });
    const evt = keyEvent({ key: "b", ctrlKey: true }, document.body);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("handleKeydown — Mod+Enter (compile) gating", () => {
  it("does not compile from a Settings input but preventDefaults the owned key", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+Enter", scope: "editor", run });
    const input = el("input");
    const evt = keyEvent({ key: "Enter", ctrlKey: true }, input);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
    // Editor-scoped Mod combo matched but was gated: still suppress the native
    // default so it never leaks a stray behavior into the focused field.
    expect(evt.defaultPrevented).toBe(true);
  });

  it("compiles when the editor surface has focus", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+Enter", scope: "editor", run });
    const cm = el("div", { class: "cm-content" });
    const target = childOf(cm);
    const evt = keyEvent({ key: "Enter", ctrlKey: true }, target);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("handleKeydown — typing-in-input suppression for global commands", () => {
  it("suppresses a non-Mod global shortcut while typing in an input", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "/", scope: "global", run });
    const input = el("input");
    const evt = keyEvent({ key: "/" }, input);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  it("lets a Mod global shortcut break out of an input", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+K", scope: "global", run });
    const input = el("input");
    const evt = keyEvent({ key: "k", ctrlKey: true }, input);

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
    expect(evt.defaultPrevented).toBe(true);
  });

  it("suppresses global shortcuts while typing in a contentEditable (non-cm) surface", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "/", scope: "global", run });
    const editable = el("div");
    Object.defineProperty(editable, "isContentEditable", { value: true });
    const evt = keyEvent({ key: "/" }, editable);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
  });
});

describe("handleKeydown — when() gating", () => {
  it("skips a command whose when() returns false but preventDefaults the Mod key", () => {
    const run = vi.fn();
    const cmd = makeCmd({
      shortcut: "Mod+S",
      scope: "editor",
      when: () => false,
      run,
    });
    const cm = el("div", { class: "cm-content" });
    const target = childOf(cm);
    const evt = keyEvent({ key: "s", ctrlKey: true }, target);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(true);
  });

  it("runs a command whose when() returns true", () => {
    const run = vi.fn();
    const cmd = makeCmd({
      shortcut: "Mod+S",
      scope: "editor",
      when: () => true,
      run,
    });
    const cm = el("div", { class: "cm-content" });
    const evt = keyEvent({ key: "s", ctrlKey: true }, childOf(cm));

    handleKeydown(evt, [cmd]);

    expect(run).toHaveBeenCalledTimes(1);
  });
});

describe("handleKeydown — no-match and first-match-wins", () => {
  it("is a no-op when no command matches the key", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: "Mod+K", scope: "global", run });
    const evt = keyEvent({ key: "j", ctrlKey: true }, document.body);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
    expect(evt.defaultPrevented).toBe(false);
  });

  it("ignores commands with no shortcut", () => {
    const run = vi.fn();
    const cmd = makeCmd({ shortcut: undefined, run });
    const evt = keyEvent({ key: "k", ctrlKey: true }, document.body);

    handleKeydown(evt, [cmd]);

    expect(run).not.toHaveBeenCalled();
  });

  it("dispatches the first registered command when two share a shortcut", () => {
    const first = vi.fn();
    const second = vi.fn();
    const cmds = [
      makeCmd({ id: "a", shortcut: "Mod+K", scope: "global", run: first }),
      makeCmd({ id: "b", shortcut: "Mod+K", scope: "global", run: second }),
    ];
    const evt = keyEvent({ key: "k", ctrlKey: true }, document.body);

    handleKeydown(evt, cmds);

    expect(first).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();
  });

  it("stops scanning after the first dispatch (does not run a later match)", () => {
    const gatedFirst = vi.fn();
    const laterGlobal = vi.fn();
    const cmds = [
      // Editor-scoped, gated out (target is body) — matched-but-gated, continues.
      makeCmd({ id: "editor", shortcut: "Mod+K", scope: "editor", run: gatedFirst }),
      // Global fallback on the same key should then win.
      makeCmd({ id: "global", shortcut: "Mod+K", scope: "global", run: laterGlobal }),
    ];
    const evt = keyEvent({ key: "k", ctrlKey: true }, document.body);

    handleKeydown(evt, cmds);

    expect(gatedFirst).not.toHaveBeenCalled();
    expect(laterGlobal).toHaveBeenCalledTimes(1);
  });
});
