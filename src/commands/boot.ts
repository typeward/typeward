import type { EditorAdapter, EditorCommand } from "~/adapters/types";
import {
  closePalette,
  openNewProjectDialog,
  openSettings,
  saveAndCompileActiveProject,
  toggleCommandPalette,
} from "./actions";
import { registerCommand, unregisterCommand } from "./registry";
import { notifyError, notifySuccess } from "~/lib/toast";
import { PRO_DISCOVERY_ENABLED } from "~/config/pro";
import { hasEntitlement } from "~/integrations/entitlements";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import { activeFile, project } from "~/stores/editor-store";
import {
  paletteOpen_,
  setRequestHistoryPanel,
  setRequestProDialog,
  setRequestSaveTemplate,
} from "./palette-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { createThread } from "~/lib/reviews/types";
import { addThread, requestReviewPanelIntent } from "~/stores/review-store";
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
    // Custom templates are Pro (templates.custom.max is '0' on free).
    when: () => project() !== null && hasEntitlement("templates.custom.max"),
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
    id: "core.whatsInPro",
    title: "What's in Pro",
    subtitle: "Plans, pricing, and what Typeward Pro unlocks",
    group: "Navigation",
    scope: "global",
    // While discovery is on, deliberately visible on every tier — Pro users
    // get the "you're on Pro" state. This is the one allowed palette entry
    // about plans; the locked features' own commands stay hidden (palette
    // noise rule). Hidden entirely during the free-only beta.
    when: () => PRO_DISCOVERY_ENABLED,
    run: () => {
      setRequestProDialog(true);
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
    title: "File history",
    subtitle: "Browse and restore earlier versions of the active file",
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
    // All reference integrations are Pro; the local DOI store (local.bib)
    // only ever gains entries through the Pro-gated lookup dialog.
    when: () =>
      project() !== null &&
      (hasEntitlement("integrations.references.zotero.local") ||
        hasEntitlement("integrations.references.doi_lookup")),
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
      const anchorText = view.state.doc.sliceString(sel.from, sel.to);
      const thread = createThread(f.relPath, sel.from, sel.to, anchorText, "You", "");
      // The store is the single source of truth; the CM decoration bridge
      // (syncThreadsToView, driven from the shell) picks this up and renders
      // the new anchor. No direct RangeSet dispatch here.
      addThread(thread);
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
      const anchorText = view.state.doc.sliceString(sel.from, sel.to);
      const thread = createThread(
        f.relPath,
        sel.from,
        sel.to,
        anchorText,
        "You",
        "",
        "todo",
      );
      addThread(thread);
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
    id: "core.reportBug",
    title: "Report a bug",
    subtitle: "Open a GitHub issue prefilled with your app and system info",
    group: "Help",
    scope: "global",
    run: async () => {
      const { openBugReport } = await import("~/lib/bug-report");
      await openBugReport();
    },
  },
];

// Dev builds only: exercises the full unhandled-error -> Sentry transport ->
// CSP pipeline. Tree-shaken out of release bundles.
if (import.meta.env.DEV) {
  CORE_COMMANDS.push({
    id: "dev.sentryTest",
    title: "Send Sentry test error",
    subtitle: "Throw an unhandled error to verify Sentry delivery (dev only)",
    group: "Developer",
    scope: "global",
    run: async () => {
      const { shareCrashReports } = await import("~/stores/settings-store");
      if (!shareCrashReports()) {
        const { notifyError } = await import("~/lib/toast");
        notifyError(
          "Crash reporting is off",
          "Enable Settings > Security > Share crash reports first - the test would silently no-op.",
        );
        return;
      }
      const { sendTestError } = await import("~/lib/sentry");
      sendTestError();
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
