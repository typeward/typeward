import { createSignal } from "solid-js";
import type { EditorCommand } from "~/adapters/types";

/**
 * Single source of truth for runnable commands — toolbar buttons, command
 * palette entries, and keybindings all read from here. Adapters and screens
 * register their commands at startup; nothing should hardcode command lookup
 * in components.
 *
 * Backed by a Solid signal so consumers (palette, keybinding router) update
 * reactively as commands are registered/unregistered.
 */
const [commandMap, setCommandMap] = createSignal<ReadonlyMap<string, EditorCommand>>(
  new Map(),
);

export const commands = (): readonly EditorCommand[] =>
  Array.from(commandMap().values());

export const getCommand = (id: string): EditorCommand | undefined =>
  commandMap().get(id);

export function registerCommand(cmd: EditorCommand): void {
  setCommandMap((prev) => {
    const next = new Map(prev);
    next.set(cmd.id, cmd);
    return next;
  });
}

export function unregisterCommand(id: string): void {
  setCommandMap((prev) => {
    if (!prev.has(id)) return prev;
    const next = new Map(prev);
    next.delete(id);
    return next;
  });
}

/** Test-only: wipe the registry. Not exported from the package barrel. */
export function _resetForTests(): void {
  setCommandMap(new Map());
}
