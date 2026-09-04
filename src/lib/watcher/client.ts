import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

export type WatcherEventKind =
  | "create"
  | "modify"
  | "remove"
  | "access"
  | "other"
  | "any";

export interface WatcherEvent {
  kind: WatcherEventKind;
  paths: string[];
  /**
   * The project's review shards changed on disk. Rust keeps `.typeward/` paths
   * out of `paths` on purpose, so this flag is how a shard write is reported:
   * in a folder-synced project it means a collaborator's comment just landed.
   * Absent on events from a build predating the flag.
   */
  reviewsChanged?: boolean;
}

export interface WatchHandle {
  projectId: string;
  /** Subscribe to file events. Returns an unsubscribe fn. */
  onEvent(handler: (event: WatcherEvent) => void): UnlistenFn;
  stop(): Promise<void>;
}

export async function watchProject(
  projectId: string,
  root: string,
): Promise<WatchHandle> {
  await invoke("watch_project", { args: { projectId, root } });
  const handlers = new Set<(event: WatcherEvent) => void>();
  const unlistenPromise = listen<WatcherEvent>(`watcher:${projectId}:event`, (e) => {
    for (const h of handlers) h(e.payload);
  });

  return {
    projectId,
    onEvent(handler) {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
      };
    },
    async stop() {
      handlers.clear();
      const unlisten = await unlistenPromise;
      unlisten();
      try {
        await invoke("unwatch_project", { projectId });
      } catch {
        // Already torn down; ignore.
      }
    },
  };
}
