import { createEffect, createRoot } from "solid-js";
import { navigateTo } from "~/commands/palette-store";
import { project as activeProject, requestGotoSource } from "~/stores/editor-store";
import { projects, refresh as refreshProjects } from "~/stores/projects-store";
import { notifyInfo } from "~/lib/toast";

/**
 * OS "Open with Typeward" bridge. Rust emits "open-with:path" with the
 * absolute path of a file passed on the command line — from the
 * single-instance callback when the app is already running, or a deferred
 * emit on first launch (see lib.rs; that emit can lose the race against a
 * slow boot, accepted for v1).
 *
 * Resolution is deliberately read-only: the file opens only when a library
 * project already contains it. Auto-importing the parent folder would turn
 * a double-click into a silent library mutation — scope decision.
 */

/** How long a navigated-to project may take to open before the pending
 *  goto intent is abandoned (slow disk / LSP contention on big projects). */
const GOTO_TIMEOUT_MS = 20_000;

const normalize = (p: string): string => p.replace(/\\/g, "/");

/** Case-insensitive containment: Windows (and default macOS) filesystems
 *  compare paths case-insensitively, and the OS may hand us a differently
 *  cased drive letter than the one the library recorded. */
const relPathWithin = (rootPath: string, filePath: string): string | null => {
  const root = normalize(rootPath).replace(/\/+$/, "");
  const file = normalize(filePath);
  if (!file.toLowerCase().startsWith(root.toLowerCase() + "/")) return null;
  return file.slice(root.length + 1);
};

/** Fire the goto intent only once the editor store carries the target
 *  project — raised earlier, EditorScreen's intent handler would resolve the
 *  relPath against the previous (or no) project. */
const gotoWhenProjectOpen = (rootPath: string, relPath: string): void => {
  createRoot((dispose) => {
    const timer = window.setTimeout(dispose, GOTO_TIMEOUT_MS);
    createEffect(() => {
      const p = activeProject();
      if (!p || p.rootPath !== rootPath) return;
      requestGotoSource(relPath, 1);
      window.clearTimeout(timer);
      dispose();
    });
  });
};

const handleOpenPath = async (rawPath: string): Promise<void> => {
  const path = typeof rawPath === "string" ? rawPath.trim() : "";
  if (!path) return;
  // The library list may not have loaded yet (first-launch emit arrives
  // right behind boot) — populate it before deciding "not a project file".
  if (projects().length === 0) {
    try {
      await refreshProjects();
    } catch {
      /* falls through to the not-found notice */
    }
  }
  for (const p of projects()) {
    const relPath = relPathWithin(p.rootPath, path);
    if (relPath === null) continue;
    navigateTo(`/editor?path=${encodeURIComponent(p.rootPath)}`);
    gotoWhenProjectOpen(p.rootPath, relPath);
    return;
  }
  notifyInfo("Open its folder as a project first", path);
};

/**
 * Listen for OS file-open requests. Mounted once from AppShell; returns the
 * cleanup. Same deferred-import shape as the menu:close-tab listener so a
 * non-Tauri context (tests, plain browser dev) stays a silent no-op.
 */
export function installOpenWith(): () => void {
  let unlisten: (() => void) | undefined;
  let disposed = false;
  void (async () => {
    try {
      const { listen } = await import("@tauri-apps/api/event");
      unlisten = await listen<string>("open-with:path", (event) => {
        void handleOpenPath(event.payload);
      });
      if (disposed) {
        unlisten();
        unlisten = undefined;
      }
    } catch {
      /* non-Tauri context */
    }
  })();
  return () => {
    disposed = true;
    unlisten?.();
  };
}
