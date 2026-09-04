import type { Component, JSX } from "solid-js";

/**
 * Widget contract. Every widget is a self-contained card rendered inside the
 * Projects screen's widget shelf. Users toggle widgets via the Widgets
 * dropdown above the project grid; enable state persists in the workspace
 * store + Rust settings.
 *
 * Spec: /design/widgets.md
 */
export interface WidgetDef {
  /** Stable id, used in settings persistence. */
  id: string;
  title: string;
  /** Short blurb shown in the Widgets dropdown. */
  description: string;
  defaultEnabled: boolean;
  icon: (size?: number) => JSX.Element;
  /** Render the widget body. The shelf provides its own card chrome. */
  Render: Component;
  /** Sort order in the shelf + menu (lower first). */
  order: number;
  /** When `true`, the widget is registered but renders a "Coming soon" stub. */
  stub?: boolean;
}

const registry = new Map<string, WidgetDef>();

export function registerWidget(def: WidgetDef): void {
  registry.set(def.id, def);
}

export function getWidget(id: string): WidgetDef | undefined {
  return registry.get(id);
}

export function listWidgets(): WidgetDef[] {
  return [...registry.values()].sort((a, b) => a.order - b.order);
}
