import type { EditorAdapter, EditorCommand } from "~/adapters/types";
import {
  closePalette,
  openNewProjectDialog,
  openSettings,
  saveActiveFile,
  toggleCommandPalette,
} from "./actions";
import { registerCommand, unregisterCommand } from "./registry";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import { activeFile, project } from "~/stores/editor-store";
import { paletteOpen_ } from "./palette-store";

/**
 * Commands available regardless of which screen is mounted. The keyboard
 * router and the palette both read from the same registry — register once
 * at app boot.
 */
const CORE_COMMANDS: EditorCommand[] = [
  {
    id: "core.togglePalette",
    title: "Toggle command palette",
    shortcut: "Mod+K",
    group: "Navigation",
    scope: "global",
    run: () => {
      toggleCommandPalette();
    },
  },
  {
    id: "core.closePalette",
    title: "Close command palette",
    shortcut: "Escape",
    group: "Navigation",
    scope: "global",
    // Only consume Escape when the palette is open; otherwise let the key
    // pass through so it can dismiss menus / clear selection / etc.
    when: () => paletteOpen_(),
    run: () => {
      closePalette();
    },
  },
  {
    id: "core.newProject",
    title: "New project",
    subtitle: "Open the new-project dialog on the Projects screen",
    shortcut: "Mod+N",
    group: "Project",
    scope: "global",
    run: () => {
      openNewProjectDialog();
    },
  },
  {
    id: "core.openSettings",
    title: "Open Settings",
    shortcut: "Mod+,",
    group: "Navigation",
    scope: "global",
    run: () => {
      openSettings();
    },
  },
  {
    id: "core.save",
    title: "Save file",
    subtitle: "Persist the active editor buffer to disk",
    shortcut: "Mod+S",
    group: "File",
    scope: "editor",
    when: () => activeFile()?.dirty === true,
    run: async () => {
      await saveActiveFile();
    },
  },
  {
    id: "references.refreshLibrary",
    title: "Refresh reference library",
    subtitle: "Re-pull every reference provider and rewrite .typeward/citations/library.bib",
    group: "References",
    scope: "global",
    when: () => project() !== null,
    run: async () => {
      const proj = project();
      if (proj) await refreshLibraryBib(proj);
    },
  },
  // Note: compile is intentionally not a core command. Each adapter ships
  // its own format-specific compile entry (LatexAdapter → "Compile LaTeX",
  // future Typst → "Compile Typst") which gets registered while a project
  // of that format is open. That keeps Mod+Enter contextual.
];

/**
 * Idempotent by id — registerCommand replaces, so calling this more than
 * once is safe and re-syncs the registry to the canonical core set.
 */
export const bootCoreCommands = (): void => {
  for (const cmd of CORE_COMMANDS) {
    registerCommand(cmd);
  }
};

/**
 * Adapter commands are scoped to the lifetime of an open project. The
 * editor screen calls register on project load and unregister on cleanup.
 */
export const registerAdapterCommands = (adapter: EditorAdapter): void => {
  for (const cmd of adapter.commands) {
    registerCommand(cmd);
  }
};

export const unregisterAdapterCommands = (adapter: EditorAdapter): void => {
  for (const cmd of adapter.commands) {
    unregisterCommand(cmd.id);
  }
};
