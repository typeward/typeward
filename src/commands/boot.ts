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
import { paletteOpen_, setRequestSaveTemplate } from "./palette-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { createThread } from "~/lib/reviews/types";
import { addThread } from "~/stores/review-store";
import { dispatchSetThreads, getCurrentRanges } from "~/lib/reviews/cm6";
import { toggleFocusMode } from "~/stores/ui-store";

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
    id: "core.saveTemplate",
    title: "Save project as template",
    subtitle: "Capture the current project as a reusable custom template",
    group: "Project",
    scope: "global",
    when: () => project() !== null,
    run: () => {
      setRequestSaveTemplate(true);
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
  {
    id: "review.addComment",
    title: "Add Review Comment",
    subtitle: "Start a review thread on the current selection",
    shortcut: "Mod+Shift+M",
    group: "Review",
    scope: "editor",
    when: () => {
      const view = getActiveEditorView();
      if (!view) return false;
      const sel = view.state.selection.main;
      return sel.from !== sel.to && activeFile() !== null;
    },
    run: () => {
      const view = getActiveEditorView();
      const f = activeFile();
      if (!view || !f) return;
      const sel = view.state.selection.main;
      if (sel.from === sel.to) return;
      const anchorText = view.state.doc.sliceString(sel.from, sel.to);
      const thread = createThread(f.relPath, sel.from, sel.to, anchorText, "You", "");
      addThread(thread);
      const existing = getCurrentRanges(view);
      dispatchSetThreads(view, [
        ...existing,
        { id: thread.id, from: sel.from, to: sel.to, status: "open" },
      ]);
    },
  },
  {
    id: "review.togglePanel",
    title: "Toggle Review Panel",
    subtitle: "Show or hide the review sidebar",
    group: "Review",
    scope: "global",
    when: () => project() !== null,
    run: () => {
      window.dispatchEvent(new CustomEvent("typeward:toggle-review-panel"));
    },
  },
  {
    id: "core.toggleFocusMode",
    title: "Toggle Focus Mode",
    subtitle: "Hide editor chrome — just source and page",
    shortcut: "Mod+Shift+F",
    group: "View",
    scope: "global",
    when: () => project() !== null,
    run: () => {
      toggleFocusMode();
    },
  },
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
