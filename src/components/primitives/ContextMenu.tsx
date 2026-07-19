import type { Component, JSX } from "solid-js";
import { createSignal, onCleanup, onMount } from "solid-js";
import { Portal } from "solid-js/web";
import { installDismiss } from "~/lib/dismiss";
import { clampMenuPosition } from "~/lib/menu-position";

/**
 * Hand-rolled fixed-position context menu. App.tsx suppresses the native menu
 * app-wide, so every right-click surface renders one of these. Handles
 * Escape/outside-click (installDismiss), close-on-scroll (capture phase so a
 * scroll INSIDE the menu — e.g. an overflowing submenu column — doesn't close
 * it), viewport clamping, and roving arrow-key focus over its `role="menuitem"`
 * children. Extracted from `ProjectMenu` so the FileTree menus reuse it.
 */

interface ContextMenuProps {
  x: number;
  y: number;
  onClose: () => void;
  /** Menu width in px for the fixed-width container + clamp estimate. */
  widthPx?: number;
  children: JSX.Element;
}

export const ContextMenu: Component<ContextMenuProps> = (props) => {
  const [pos, setPos] = createSignal({ x: props.x, y: props.y });
  let menuRef: HTMLDivElement | undefined;

  installDismiss(() => menuRef, () => true, () => props.onClose());

  onMount(() => {
    const el = menuRef;
    if (!el) return;
    const restoreTo =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
    onCleanup(() => {
      // Restore only when focus is still inside the (unmounting) menu or
      // already fell to <body> — an outside-click dismissal that focused
      // something else (e.g. the CodeMirror document) must keep its focus.
      const active = document.activeElement;
      const focusIsLoose =
        active === document.body || active === null || el.contains(active);
      if (focusIsLoose && restoreTo?.isConnected) restoreTo.focus();
    });
    const r = el.getBoundingClientRect();
    const { x, y } = clampMenuPosition({
      x: props.x,
      y: props.y,
      menuWidth: r.width,
      menuHeight: r.height,
      viewportWidth: window.innerWidth,
      viewportHeight: window.innerHeight,
    });
    if (x !== props.x || y !== props.y) setPos({ x, y });
    requestAnimationFrame(() =>
      el.querySelector<HTMLElement>('[role="menuitem"]:not([disabled])')?.focus(),
    );
    // Close when the page behind the menu scrolls, but not when the scroll
    // happens inside the menu itself — a capture-phase listener receives those
    // descendant scroll events too.
    const onScroll = (e: Event) => {
      if (menuRef && e.target instanceof Node && menuRef.contains(e.target)) return;
      props.onClose();
    };
    window.addEventListener("scroll", onScroll, true);
    onCleanup(() => window.removeEventListener("scroll", onScroll, true));
  });

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Escape") {
      e.stopPropagation();
      props.onClose();
      return;
    }
    const items = Array.from(
      menuRef?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? [],
    );
    if (items.length === 0) return;
    const idx = items.indexOf(document.activeElement as HTMLElement);
    const focusAt = (to: number) => {
      e.preventDefault();
      items[(to + items.length) % items.length]?.focus();
    };
    switch (e.key) {
      case "ArrowDown":
        focusAt(idx < 0 ? 0 : idx + 1);
        break;
      case "ArrowUp":
        focusAt(idx < 0 ? items.length - 1 : idx - 1);
        break;
      case "Home":
        focusAt(0);
        break;
      case "End":
        focusAt(items.length - 1);
        break;
    }
  };

  return (
    <Portal>
      <div
        ref={menuRef}
        role="menu"
        tabindex={-1}
        onKeyDown={onKeyDown}
        class="glass fixed z-50 flex flex-col rounded-lg"
        style={{
          left: `${pos().x}px`,
          top: `${pos().y}px`,
          width: `${props.widthPx ?? 224}px`,
          padding: "5px",
          background: "var(--color-popover-bg)",
        }}
      >
        {props.children}
      </div>
    </Portal>
  );
};

export const ContextMenuItem: Component<{
  icon?: Component<{ size?: number; class?: string }>;
  label: string;
  danger?: boolean;
  disabled?: boolean;
  trailing?: JSX.Element;
  /** Set when the item toggles an inline submenu (adds aria-haspopup/expanded). */
  expanded?: boolean;
  onClick: () => void;
}> = (props) => (
  <button
    type="button"
    role="menuitem"
    tabindex={-1}
    disabled={props.disabled}
    aria-haspopup={props.expanded !== undefined ? "menu" : undefined}
    aria-expanded={props.expanded}
    onClick={props.onClick}
    class={`lift flex w-full items-center gap-2.5 rounded-md px-2 text-left text-sm disabled:pointer-events-none disabled:opacity-50 ${
      props.danger
        ? "text-[var(--color-err)] hover:bg-[color-mix(in_srgb,var(--color-err)_14%,transparent)]"
        : "text-fg-2 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
    }`}
    style={{ height: "var(--ui-row-sm)" }}
  >
    {props.icon ? <props.icon size={13} class="flex-shrink-0" /> : null}
    <span class="flex-1">{props.label}</span>
    {props.trailing}
  </button>
);

export const ContextMenuSeparator: Component = () => (
  <div class="my-1 h-px bg-glass-stroke" />
);

export interface ContextMenuState<T> {
  x: number;
  y: number;
  payload: T;
}

/**
 * Signal + openers for a payload-carrying context menu. `openAt` preempts the
 * app-wide native-menu suppressor (preventDefault + stopPropagation) and stores
 * the click coordinates so `<ContextMenu>` positions itself under the cursor.
 */
export function createContextMenuState<T>() {
  const [menu, setMenu] = createSignal<ContextMenuState<T> | null>(null);
  const openAt = (e: MouseEvent, payload: T) => {
    e.preventDefault();
    e.stopPropagation();
    setMenu({ x: e.clientX, y: e.clientY, payload });
  };
  const close = () => setMenu(null);
  return { menu, openAt, close };
}
