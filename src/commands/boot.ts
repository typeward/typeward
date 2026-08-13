import type { EditorAdapter, EditorCommand } from "~/adapters/types";
import {
  closePalette,
  openNewProjectDialog,
  openSettings,
  saveAndCompileActiveProject,
  toggleCommandPalette,
} from "./actions";
import {
  activeFormattingLanguage,
  applyFormat,
  supportsFormat,
  type FormatKind,
} from "./format-actions";
import { registerCommand, unregisterCommand } from "./registry";
import { notifyError, notifySuccess } from "~/lib/toast";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import { activeFile, project } from "~/stores/editor-store";
import {
  paletteOpen_,
  setRequestHistoryPanel,
  setRequestSaveTemplate,
} from "./palette-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import {
  requestReviewCompose,
  requestReviewPanelIntent,
} from "~/stores/review-store";
import { editorSettings, setEditorSettings } from "~/stores/settings-store";
import { toggleFocusMode } from "~/stores/ui-store";
import { isVisualEligibleFile } from "~/adapters/languages";

// Editor focus is already the `scope: "editor"` gate in the keyboard router;
// this adds the per-dialect capability check on top (markdown has no
// underline, and a .bib file takes no prose formatting at all).
const formatAvailable = (kind: FormatKind): boolean => {
  const lang = activeFormattingLanguage();
  return lang !== null && supportsFormat(lang, kind);
};

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
    title: "Save and compile",
    subtitle: "Persist every dirty buffer, then compile the project",
    shortcut: "Mod+S",
    group: "File",
    scope: "editor",
    when: () => activeFile() !== null,
    run: async () => {
      await saveAndCompileActiveProject();
    },
  },
  {
    id: "core.fileHistory",
    title: "Project history",
    subtitle: "Browse and restore earlier versions across the project",
    group: "File",
    scope: "global",
    when: () => activeFile() !== null,
    run: () => {
      setRequestHistoryPanel(true);
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
      if (!proj) return;
      const result = await refreshLibraryBib(proj);
      if (result.providersFailed > 0) {
        notifyError(
          `${result.providersFailed} reference source${result.providersFailed === 1 ? "" : "s"} failed`,
          result.failures.map((f) => `${f.providerId}: ${f.message}`).join("\n"),
        );
      } else {
        notifySuccess("Reference library refreshed", `${result.totalKeys} citations`);
      }
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
      // Raise a compose intent instead of creating the thread outright: the
      // popover collects the note first (matching the PDF selection flow),
      // and only its submit adds the thread to the store.
      requestReviewCompose({
        kind: "comment",
        from: sel.from,
        to: sel.to,
        anchorText: view.state.doc.sliceString(sel.from, sel.to),
      });
    },
  },
  {
    id: "review.addTodo",
    title: "Add TODO",
    subtitle: "Flag the current selection as a TODO",
    shortcut: "Mod+Shift+T",
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
      requestReviewCompose({
        kind: "todo",
        from: sel.from,
        to: sel.to,
        anchorText: view.state.doc.sliceString(sel.from, sel.to),
      });
    },
  },
  {
    id: "review.togglePanel",
    title: "Open Review Panel",
    subtitle: "Show the review sidebar",
    group: "Review",
    scope: "global",
    when: () => project() !== null,
    run: () => {
      requestReviewPanelIntent();
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
  {
    id: "core.toggleVisualMode",
    title: "Toggle Visual Editing",
    subtitle: "Edit LaTeX as a formatted document",
    shortcut: "Mod+Shift+V",
    group: "View",
    scope: "global",
    // Visual mode is LaTeX-only (.tex); the toggle writes the persisted
    // editor.visualModeLatex setting — the FormatToolbar control is the
    // same setting, so focus mode hiding the toolbar doesn't strand it.
    when: () => {
      const f = activeFile();
      return f !== null && isVisualEligibleFile(f.relPath);
    },
    run: () => {
      setEditorSettings({
        ...editorSettings(),
        visualModeLatex: !editorSettings().visualModeLatex,
      });
    },
  },
  {
    id: "format.bold",
    title: "Bold",
    subtitle: "Wrap the selection in bold, or insert the empty construct",
    shortcut: "Mod+B",
    group: "Format",
    scope: "editor",
    when: () => formatAvailable("bold"),
    run: () => {
      applyFormat("bold");
    },
  },
  {
    id: "format.italic",
    title: "Italic",
    subtitle: "Wrap the selection in italics, or insert the empty construct",
    shortcut: "Mod+I",
    group: "Format",
    scope: "editor",
    when: () => formatAvailable("italic"),
    run: () => {
      applyFormat("italic");
    },
  },
  {
    id: "format.underline",
    title: "Underline",
    subtitle: "Wrap the selection in an underline, or insert the empty construct",
    shortcut: "Mod+U",
    group: "Format",
    scope: "editor",
    when: () => formatAvailable("underline"),
    run: () => {
      applyFormat("underline");
    },
  },
];

// Palette-only parity with the rest of the FormatToolbar. Deliberately no
// shortcuts: Mod+M (inline math) collides with macOS window-minimize, and
// none of the others has an established binding worth spending a chord on.
const PALETTE_FORMAT_COMMANDS: ReadonlyArray<{
  kind: FormatKind;
  title: string;
  subtitle: string;
}> = [
  { kind: "code", title: "Inline Code", subtitle: "Wrap the selection in inline code" },
  { kind: "heading", title: "Heading", subtitle: "Turn the selection into a heading" },
  { kind: "list", title: "Bulleted List", subtitle: "Convert selected lines to a bulleted list" },
  { kind: "orderedList", title: "Numbered List", subtitle: "Convert selected lines to a numbered list" },
  { kind: "quote", title: "Block Quote", subtitle: "Wrap the selection in a block quote" },
  { kind: "inlineMath", title: "Insert Inline Math", subtitle: "Insert inline math at the cursor" },
  { kind: "equation", title: "Insert Equation", subtitle: "Insert a display equation" },
  { kind: "figure", title: "Insert Figure", subtitle: "Insert a figure block" },
  { kind: "table", title: "Insert Table", subtitle: "Insert a table skeleton" },
  { kind: "link", title: "Insert Link", subtitle: "Insert a link" },
  { kind: "citation", title: "Insert Citation", subtitle: "Insert a citation at the cursor" },
];

for (const f of PALETTE_FORMAT_COMMANDS) {
  CORE_COMMANDS.push({
    id: `format.${f.kind}`,
    title: f.title,
    subtitle: f.subtitle,
    group: "Format",
    scope: "editor",
    when: () => formatAvailable(f.kind),
    run: () => {
      applyFormat(f.kind);
    },
  });
}

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
