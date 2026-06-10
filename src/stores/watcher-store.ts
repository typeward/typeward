import { createSignal } from "solid-js";
import { watchProject, type WatchHandle } from "~/lib/watcher/client";

/**
 * `fsVersion` bumps every time the unified file watcher emits an event we
 * care about. UI surfaces (FileTree, anything else that lists files) depend
 * on it so they re-fetch when files appear / disappear / change on disk.
 *
 * Events under `.typeward/` (snapshots, build cache) are filtered out so
 * autosave doesn't trigger a refresh loop.
 */
const [fsVersion, setFsVersion] = createSignal(0);

let currentHandle: WatchHandle | null = null;
let currentUnsubscribe: (() => void) | null = null;

function sanitizeId(root: string): string {
  return root.replace(/[^A-Za-z0-9]/g, "_");
}

const TYPEWARD_DIR_PATTERN = /[\\/]\.typeward[\\/]/;

async function startWatching(
  root: string,
  isCurrent: () => boolean = () => true,
): Promise<void> {
  await stopWatching();
  if (!isCurrent()) return;
  try {
    const handle = await watchProject(sanitizeId(root), root);
    if (!isCurrent()) {
      await handle.stop().catch(() => {
        /* stale startup; watcher may already be gone */
      });
      return;
    }
    currentHandle = handle;
    currentUnsubscribe = handle.onEvent((ev) => {
      // Bump if the batch touches any real project file. The Rust watcher
      // already strips `.typeward/` paths and coalesces bursts; this is the
      // defensive second layer. (Filtering per-path, not dropping the whole
      // batch when one path happens to be a snapshot — a coalesced event can
      // legitimately carry both.)
      const touchesRealFile = ev.paths.some((p) => !TYPEWARD_DIR_PATTERN.test(p));
      if (!touchesRealFile) return;
      setFsVersion((n) => n + 1);
    });
  } catch (e) {
    // Watcher is best-effort; an unsupported filesystem or permission error
    // shouldn't break the editor.
    console.warn("file watcher failed to start:", e);
  }
}

async function stopWatching(): Promise<void> {
  if (currentUnsubscribe) {
    currentUnsubscribe();
    currentUnsubscribe = null;
  }
  if (currentHandle) {
    await currentHandle.stop().catch(() => {
      /* already torn down */
    });
    currentHandle = null;
  }
}

export { fsVersion, startWatching, stopWatching };
