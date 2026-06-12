import {
  Activity,
  ArrowRight,
  ChevronDown,
  GripVertical,
  Settings2,
  X,
} from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";

import { navigateTo } from "~/commands/palette-store";
import { installDismiss } from "~/lib/dismiss";
import { projects } from "~/stores/projects-store";
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

/**
 * Projects-screen dashboard. One opt-in panel above the grid: a fixed
 * Activity card (library stats + jump back in) plus the registered cards,
 * each toggleable from the Customize menu and drag-reorderable (desktop).
 * Replaces the old free-floating widget shelf — the cards now live inside
 * a single panel the user turns on or off as a whole.
 *
 * Spec: /design/widgets.md
 */
export const DashboardPanel: Component = () => {
  const [draggingId, setDraggingId] = createSignal<string | null>(null);

  const isOn = (w: WidgetDef) => {
    const explicit = widgetEnabled()[w.id];
    return explicit === undefined ? w.defaultEnabled : explicit;
  };

  // Persisted order first (unknown ids dropped), then any cards the order
  // list doesn't know about yet, in registry order.
  const orderedCards = createMemo<WidgetDef[]>(() => {
    const enabled = listWidgets().filter(isOn);
    const byId = new Map(enabled.map((w) => [w.id, w]));
    const out: WidgetDef[] = [];
    for (const id of dashboardOrder()) {
      const w = byId.get(id);
      if (w) {
        out.push(w);
        byId.delete(id);
      }
    }
    return [...out, ...byId.values()];
  });

  const moveCard = (dragId: string, overId: string) => {
    if (dragId === overId) return;
    const ids = orderedCards().map((w) => w.id);
    const from = ids.indexOf(dragId);
    const to = ids.indexOf(overId);
    if (from < 0 || to < 0) return;
    ids.splice(to, 0, ...ids.splice(from, 1));
    setDashboardOrder(ids);
  };

  return (
    <div
      class="glass-soft flex flex-col gap-2 rounded-xl"
      style={{ padding: "var(--ui-pad-card)" }}
    >
      <div class="flex items-center gap-2 px-1">
        <Activity size={13} style={{ color: "var(--color-accent-1)" }} />
        <span class="label-xs text-fg-2">Dashboard</span>
        <Show when={!isTabletViewport() && orderedCards().length > 1}>
          <span class="mono text-[10px] text-fg-4">drag cards to rearrange</span>
        </Show>
        <div class="ml-auto flex items-center gap-1">
          <CustomizeMenu />
          <button
            type="button"
            onClick={() => setDashboardEnabled(false)}
            title="Hide dashboard"
            aria-label="Hide dashboard"
            class="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
          >
            <X size={12} />
          </button>
        </div>
      </div>

      <div
        class={`flex gap-2 overflow-x-auto scroll pb-1 ${
          isTabletViewport() ? "flex-col" : ""
        }`}
      >
        <DashboardCard title="Activity" icon={<Activity size={13} />}>
          <ActivityBody />
        </DashboardCard>

        <For each={orderedCards()}>
          {(w) => (
            <DashboardCard
              title={w.title}
              icon={w.icon(13)}
              draggable={!isTabletViewport()}
              dragging={draggingId() === w.id}
              onDragStart={(e) => {
                setDraggingId(w.id);
                e.dataTransfer?.setData("text/plain", w.id);
                if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
              }}
              onDragOver={(e) => {
                const dragId = draggingId();
                if (!dragId) return;
                e.preventDefault();
                moveCard(dragId, w.id);
              }}
              onDragEnd={() => setDraggingId(null)}
            >
              <w.Render />
            </DashboardCard>
          )}
        </For>
      </div>
    </div>
  );
};

/** Library stats + "jump back in" — the panel's fixed first card. */
const ActivityBody: Component = () => {
  const byFormat = () => {
    const counts = new Map<string, number>();
    for (const p of projects()) {
      counts.set(p.format, (counts.get(p.format) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  // The Rust listing's insertion order is the closest thing to "recent"
  // until per-project opened-at metadata lands; same assumption as the
  // Recent-projects card.
  const latest = () => projects()[0];

  return (
    <div class="flex h-full flex-col justify-center gap-2.5 px-1">
      <div class="flex items-baseline gap-2">
        <span class="text-[28px] font-semibold tracking-tight text-fg-1">
          {projects().length}
        </span>
        <span class="mono text-[length:var(--ui-font-xs)] text-fg-3">
          project{projects().length === 1 ? "" : "s"} in your library
        </span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <For each={byFormat()}>
          {([format, count]) => (
            <span
              class="mono rounded-full px-2 py-0.5 text-[10px] uppercase text-fg-2"
              style={{ background: "var(--color-control-fill)" }}
            >
              {format} · {count}
            </span>
          )}
        </For>
      </div>
      <Show when={latest()}>
        <button
          type="button"
          onClick={() =>
            navigateTo(`/editor?path=${encodeURIComponent(latest()!.rootPath)}`)
          }
          class="lift glass-inset flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--color-control-fill)]"
        >
          <span class="text-[length:var(--ui-font-xs)] text-fg-3">Continue</span>
          <span class="truncate text-[length:var(--ui-font-sm)] font-medium text-fg-1">
            {latest()!.name}
          </span>
          <ArrowRight size={11} class="ml-auto flex-shrink-0 text-fg-3" />
        </button>
      </Show>
    </div>
  );
};

const DashboardCard: Component<{
  title: string;
  icon: ReturnType<WidgetDef["icon"]>;
  draggable?: boolean;
  dragging?: boolean;
  onDragStart?: (e: DragEvent) => void;
  onDragOver?: (e: DragEvent) => void;
  onDragEnd?: () => void;
  children: ReturnType<Component>;
}> = (props) => (
  <div
    draggable={props.draggable ? true : undefined}
    onDragStart={(e) => props.onDragStart?.(e)}
    onDragOver={(e) => props.onDragOver?.(e)}
    onDragEnd={() => props.onDragEnd?.()}
    class="flex flex-shrink-0 flex-col gap-2 rounded-xl"
    style={{
      width: isTabletViewport() ? "100%" : "300px",
      height: "190px",
      padding: "var(--ui-pad-card)",
      background: "var(--color-card-bg-soft)",
      border: "1px solid var(--color-glass-stroke)",
      opacity: props.dragging ? "0.45" : undefined,
      cursor: props.draggable ? "grab" : undefined,
    }}
  >
    <div class="flex items-center gap-2">
      <span style={{ color: "var(--color-accent-1)" }}>{props.icon}</span>
      <span class="label-xs text-fg-2">{props.title}</span>
      <Show when={props.draggable}>
        <GripVertical size={11} class="ml-auto text-fg-4" />
      </Show>
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
            The Activity card is always first; the rest drag to rearrange.
          </div>
        </div>
      </Show>
    </div>
  );
};
