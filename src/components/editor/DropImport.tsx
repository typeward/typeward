import type { UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { FolderInput } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createSignal, onCleanup, onMount } from "solid-js";
import * as ipc from "~/ipc";
import { describeIpcError } from "~/lib/errors";
import { recordError } from "~/lib/telemetry";
import { notifyError, notifySuccess } from "~/lib/toast";
import { project } from "~/stores/editor-store";

/**
 * OS drag-drop → project import. Subscribes to the webview's native drag-drop
 * events (DOM drop events never carry OS paths in Tauri), shows a full-pane
 * overlay while files hover, and copies dropped files into the active
 * project's root via the Rust `import_files_into_project` IPC — dropped paths
 * are absolute and outside the fs plugin's runtime scope, so the copy can only
 * happen there. Mounted once inside EditorScreen; inert when no project is
 * open and on mobile (no OS drag-drop surface there).
 */
export const DropImport: Component = () => {
  const [hovering, setHovering] = createSignal(false);

  const importDropped = async (paths: string[]) => {
    const p = project();
    if (!p || paths.length === 0) return;
    try {
      const created = await ipc.importFilesIntoProject(p.rootPath, "", paths);
      if (created.length === 0) return;
      notifySuccess(
        created.length === 1
          ? `Added ${created[0].split("/").pop()}`
          : `Added ${created.length} files`,
      );
    } catch (e) {
      notifyError("Couldn't add dropped files", describeIpcError(e));
      recordError("drop-import", "importing dropped files failed", e);
    }
  };

  onMount(() => {
    if (!ipc.isDesktop()) return;
    // Non-Tauri contexts (tests) have no webview bridge to subscribe to.
    if (!("__TAURI_INTERNALS__" in globalThis)) return;
    let unlisten: UnlistenFn | undefined;
    let disposed = false;
    void getCurrentWebview()
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setHovering(project() !== null);
        } else if (payload.type === "leave") {
          setHovering(false);
        } else if (payload.type === "drop") {
          setHovering(false);
          void importDropped(payload.paths);
        }
      })
      .then((fn) => {
        // The subscription resolves async — if the component already
        // unmounted, release it immediately instead of leaking the listener.
        if (disposed) fn();
        else unlisten = fn;
      })
      .catch((e) => {
        recordError("drop-import", "subscribing to drag-drop events failed", e);
      });
    onCleanup(() => {
      disposed = true;
      unlisten?.();
    });
  });

  return (
    <Show when={hovering()}>
      <div
        class="pointer-events-none fixed inset-0 z-50 flex items-center justify-center bg-[var(--color-overlay-scrim)]"
        aria-hidden="true"
      >
        <div
          class="glass flex items-center gap-3 rounded-xl px-6 py-4"
          style={{ background: "var(--color-popover-bg)" }}
        >
          <FolderInput size={18} style={{ color: "var(--color-accent-1)" }} />
          <span class="text-base font-medium text-fg-1">
            Drop to add to {project()?.name}
          </span>
        </div>
      </div>
    </Show>
  );
};
