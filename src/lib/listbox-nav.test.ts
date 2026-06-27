import { describe, expect, it, vi } from "vitest";

import { handleListboxKeydown } from "./listbox-nav";

function makeListbox(n: number): { container: HTMLElement; opts: HTMLButtonElement[] } {
  const container = document.createElement("div");
  container.setAttribute("role", "listbox");
  const opts: HTMLButtonElement[] = [];
  for (let i = 0; i < n; i++) {
    const b = document.createElement("button");
    b.setAttribute("role", "option");
    container.appendChild(b);
    opts.push(b);
  }
  document.body.appendChild(container);
  return { container, opts };
}

const key = (k: string) =>
  new KeyboardEvent("keydown", { key: k, bubbles: true, cancelable: true });

describe("handleListboxKeydown", () => {
  it("ArrowDown moves focus to the next option", () => {
    const { container, opts } = makeListbox(3);
    opts[0].focus();
    handleListboxKeydown(key("ArrowDown"), container, () => {});
    expect(document.activeElement).toBe(opts[1]);
    container.remove();
  });

  it("ArrowDown wraps from last to first", () => {
    const { container, opts } = makeListbox(3);
    opts[2].focus();
    handleListboxKeydown(key("ArrowDown"), container, () => {});
    expect(document.activeElement).toBe(opts[0]);
    container.remove();
  });

  it("ArrowUp wraps from first to last", () => {
    const { container, opts } = makeListbox(3);
    opts[0].focus();
    handleListboxKeydown(key("ArrowUp"), container, () => {});
    expect(document.activeElement).toBe(opts[2]);
    container.remove();
  });

  it("Home and End jump to first/last", () => {
    const { container, opts } = makeListbox(3);
    opts[1].focus();
    handleListboxKeydown(key("End"), container, () => {});
    expect(document.activeElement).toBe(opts[2]);
    handleListboxKeydown(key("Home"), container, () => {});
    expect(document.activeElement).toBe(opts[0]);
    container.remove();
  });

  it("ArrowDown with nothing focused starts at the first option", () => {
    const { container, opts } = makeListbox(3);
    (document.activeElement as HTMLElement | null)?.blur?.();
    handleListboxKeydown(key("ArrowDown"), container, () => {});
    expect(document.activeElement).toBe(opts[0]);
    container.remove();
  });

  it("Escape invokes the close callback", () => {
    const { container } = makeListbox(2);
    const close = vi.fn();
    handleListboxKeydown(key("Escape"), container, close);
    expect(close).toHaveBeenCalledOnce();
    container.remove();
  });
});
