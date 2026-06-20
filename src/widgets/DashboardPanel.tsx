import {
  ChevronDown,
  GripVertical,
  Settings2,
  X,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createMemo, createSignal, onCleanup } from "solid-js";

import { installDismiss } from "~/lib/dismiss";
import { isTabletViewport } from "~/stores/viewport-store";
import {
  dashboardOrder,
  setDashboardEnabled,
  setDashboardOrder,
  toggleWidget,
  widgetEnabled,
} from "~/stores/workspace-store";

import "./builtins";
import { listWidgets, type WidgetDef } from "./registry";

interface RenderCard {
  id: string;
  title: string;
  renderIcon: () => JSX.Element;
  Body: Component;
}

/**
 * Projects-screen Widgets panel. One opt-in panel above the toolbar holding
 * the registered cards, each toggleable from the Customize menu and
 * drag-reorderable. Reordering is pointer-based (a grip pointerdown + window
 * pointermove/up + `elementFromPoint`) rather than HTML5 drag-and-drop, which
 * proved unreliable inside the webview and gave no touch support; this works
 * on desktop and tablet alike.
 *
 * Spec: /design/widgets.md
 */
export const DashboardPanel: Component = () => {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  const isOn = (w: WidgetDef) => {
    const explicit = widgetEnabled()[w.id];
    return explicit === undefined ? w.defaultEnabled : explicit;
  };

  // Stable RenderCard references, cached by id. The `<For>` below is keyed by
  // reference, so handing it fresh objects on every reorder would destroy and
  // recreate each card's DOM mid-drag — which drops the dragged grip and wedges
  // the panel in "drag mode". Reusing the same objects makes `<For>` move nodes
  // instead. Card definitions are static (icon/body/title don't change).
  const cardCache = new Map<string, RenderCard>();
  const widgetCard = (w: WidgetDef): RenderCard => {
    let c = cardCache.get(w.id);
    if (!c) {
      c = { id: w.id, title: w.title, renderIcon: () => w.icon(13), Body: w.Render };
      cardCache.set(w.id, c);
    }
    return c;
  };

  // Persisted order first (unknown ids dropped), then anything not yet placed.
  const orderedCards = createMemo<RenderCard[]>(() => {
    const cards: RenderCard[] = listWidgets().filter(isOn).map(widgetCard);
    const byId = new Map(cards.map((c) => [c.id, c]));
    const out: RenderCard[] = [];
    for (const id of dashboardOrder()) {
      const c = byId.get(id);
      if (c) {
        out.push(c);
        byId.delete(id);
      }
    }
    return [...out, ...byId.values()];
  });

  const moveCard = (dragId: string, overId: string) => {
    if (dragId === overId) return;
    const ids = orderedCards().map((c) => c.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    setDashboardOrder(ids);
  };

  // Window-level listeners (not the grip's own events) so the release is caught
  // no matter where the pointer is or whether the grip node survived a reorder.
  let activePointerId: number | null = null;

  const onWindowMove = (e: PointerEvent) => {
    if (e.pointerId !== activePointerId || !draggingId()) return;
    const over = (document.elementFromPoint(e.clientX, e.clientY) as HTMLElement | null)
      ?.closest("[data-card-id]")
      ?.getAttribute("data-card-id");
    if (over) moveCard(draggingId()!, over);
  };

  const stopListening = () => {
    window.removeEventListener("pointermove", onWindowMove);
    window.removeEventListener("pointerup", onWindowUp);
    window.removeEventListener("pointercancel", onWindowUp);
  };

  const onWindowUp = (e: PointerEvent) => {
    if (activePointerId !== null && e.pointerId !== activePointerId) return;
    activePointerId = null;
    setDraggingId(null);
    stopListening();
  };

  const startDrag = (e: PointerEvent, id: string) => {
    e.preventDefault();
    activePointerId = e.pointerId;
    setDraggingId(id);
    window.addEventListener("pointermove", onWindowMove);
    window.addEventListener("pointerup", onWindowUp);
    window.addEventListener("pointercancel", onWindowUp);
  };

  onCleanup(stopListening);

  return (
    <div
      class="glass-soft flex flex-col gap-2 rounded-xl"
      style={{ padding: "var(--ui-pad-card)" }}
    >
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1 px-1">
        <span class="label-xs text-fg-2">Widgets</span>
        <Show when={orderedCards().length > 1}>
          <span class="mono hidden text-[10px] text-fg-4 sm:inline">
            drag the grip to rearrange
          </span>
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <CustomizeMenu />
          <button
            type="button"
            onClick={() => setDashboardEnabled(false)}
            title="Hide widgets"
            aria-label="Hide widgets"
            class="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <Show
        when={orderedCards().length > 0}
        fallback={
          <div class="px-1 py-6 text-center text-[length:var(--ui-font-xs)] text-fg-3">
            No cards enabled — turn some on from Customize.
          </div>
        }
      >
        <div
          class={`gap-2 pb-1 ${isTabletViewport() ? "flex flex-col" : "grid"}`}
          style={
            isTabletViewport()
              ? undefined
              : { "grid-template-columns": "repeat(auto-fill, minmax(260px, 1fr))" }
          }
        >
          <For each={orderedCards()}>
            {(card) => (
              <DashboardCard
                cardId={card.id}
                title={card.title}
                icon={card.renderIcon()}
                dragging={draggingId() === card.id}
                onHandlePointerDown={(e) => startDrag(e, card.id)}
              >
                <card.Body />
              </DashboardCard>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
};

const DashboardCard: Component<{
  cardId: string;
  title: string;
  icon: JSX.Element;
  dragging?: boolean;
  onHandlePointerDown?: (e: PointerEvent) => void;
  children: ReturnType<Component>;
}> = (props) => (
  <div
    data-card-id={props.cardId}
    class="flex w-full min-w-0 flex-col gap-2 rounded-xl"
    style={{
      height: "236px",
      padding: "var(--ui-pad-card)",
      background: "var(--color-card-bg-soft)",
      border: "1px solid var(--color-glass-stroke)",
      opacity: props.dragging ? "0.4" : undefined,
      "box-shadow": props.dragging
        ? "0 0 0 1.5px var(--color-accent-1)"
        : undefined,
      transition: "opacity 120ms ease, box-shadow 120ms ease",
    }}
  >
    <div class="flex items-center gap-2">
      <span style={{ color: "var(--color-accent-1)" }}>{props.icon}</span>
      <span class="label-xs text-fg-2">{props.title}</span>
      <button
        type="button"
        aria-label="Drag to reorder"
        title="Drag to reorder"
        onPointerDown={(e) => props.onHandlePointerDown?.(e)}
        class="ml-auto flex h-6 w-6 items-center justify-center rounded text-fg-4 hover:bg-[var(--color-control-fill)] hover:text-fg-2"
        style={{
          cursor: props.dragging ? "grabbing" : "grab",
          "touch-action": "none",
        }}
      >
        <GripVertical size={12} />
      </button>
    </div>
    <div class="min-h-0 flex-1">{props.children}</div>
  </div>
);

/** Which cards show — checkbox list over the registry. */
const CustomizeMenu: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  const isOn = (w: WidgetDef) => {
    const explicit = widgetEnabled()[w.id];
    return explicit === undefined ? w.defaultEnabled : explicit;
  };

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        class="lift flex h-6 items-center gap-1 rounded px-1.5 text-[length:var(--ui-font-xs)] text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
      >
        <Settings2 size={11} />
        <span>Customize</span>
        <ChevronDown size={9} style={{ opacity: 0.5 }} />
      </button>
      <Show when={open()}>
        <div
          class="glass absolute right-0 top-full z-40 mt-1 w-[240px] rounded-xl"
          style={{
            padding: "var(--ui-pad-section)",
            background: "var(--color-popover-bg)",
          }}
        >
          <span class="label-xs mb-1.5 block px-1 text-fg-3">Cards</span>
          <For each={listWidgets()}>
            {(w) => (
              <button
                type="button"
                onClick={() => toggleWidget(w.id)}
                class="lift flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-[var(--color-control-fill)]"
              >
                <span
                  class="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-fg-2"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  {w.icon(12)}
                </span>
                <div class="min-w-0 flex-1">
                  <div class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                    {w.title}
                  </div>
                  <div class="mono mt-0.5 truncate text-[10px] text-fg-3">
                    {w.description}
                  </div>
                </div>
                <span
                  class="flex h-4 w-[26px] flex-shrink-0 items-center rounded-full p-0.5"
                  style={{
                    background: isOn(w)
                      ? "var(--color-accent-1)"
                      : "var(--color-control-stroke)",
                  }}
                >
                  <span
                    class="h-3 w-3 rounded-full"
                    style={{
                      background: isOn(w)
                        ? "var(--color-accent-fg)"
                        : "var(--color-fg-2)",
                      transform: isOn(w) ? "translateX(10px)" : "translateX(0)",
                      transition: "transform 150ms ease-out",
                    }}
                  />
                </span>
              </button>
            )}
          </For>
          <div class="mt-1.5 border-t border-glass-stroke px-1 pt-1.5 text-[10px] leading-relaxed text-fg-4">
            Toggle cards on or off; drag any card by its grip to rearrange.
          </div>
        </div>
      </Show>
    </div>
  );
};
