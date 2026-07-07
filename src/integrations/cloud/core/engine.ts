/**
 * Sync engine — orchestrates pull / push / delta for a single
 * (provider, project) pair.
 *
 * Phase 2.1 ships the scaffold: lifecycle, status hooks, conflict
 * detection, cursor persistence. Provider-specific transport details
 * (longpoll cadence for Dropbox) arrive with each provider.
 */

import { describeIpcError } from "~/lib/errors";
import {
  exists,
  mkdir,
  readFile,
  readTextFile,
  remove,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";

import type { CloudFsProvider, DeltaChange, RemoteFile } from "~/integrations/types";
import { recordError } from "~/lib/telemetry";

import { decideConflict, suffixWithConflict } from "./conflict";
import {
  cachePathForRemoteRel,
  cursorPathForCacheRoot,
  normalizeRemoteRelPath,
  projectCacheRoot,
  syncStatePathForCacheRoot,
  type NormalizedRelPath,
} from "./paths";
import {
  getSyncStatus,
  recordConflicts,
  setSyncPhase,
} from "./sync-status";

export interface SyncEngineOptions {
  providerId: string;
  projectId: string;
  /** Provider-side identifier of the remote root folder backing this project. */
  rootId: string;
  /** User's Typeward projects root — usually `~/Documents/Typeward`. */
  projectsRoot: string;
  /** Actual local project/cache root opened by the editor. */
  cacheRoot?: string;
  /** Default poll interval; providers can override per call (e.g. Dropbox longpoll). */
  pollIntervalMs?: number;
}

export interface PullPassResult {
  applied: number;
  conflicts: string[];
  nextCursor: string;
}

const DEFAULT_POLL_MS = 60_000;
// Coalesce a burst of saves into one upload pass; retry a failed push later.
const PUSH_DEBOUNCE_MS = 1_500;
const PUSH_RETRY_MS = 15_000;
const PUSH_RETRY_MAX_MS = 5 * 60_000;

interface SyncedFileState {
  id: string;
  relPath: NormalizedRelPath;
  rev?: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

interface SyncStateManifest {
  version: 1;
  files: Record<string, SyncedFileState>;
}

export class SyncEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pushTimer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cursor: string | undefined;
  private syncState: SyncStateManifest | undefined;
  /**
   * Serializes every pass (pull + push) so they never interleave on the
   * shared cursor/cache. `pullNow`, the poll tick, and push drains all chain
   * off this; a rejected pass doesn't poison the chain.
   */
  private chain: Promise<unknown> = Promise.resolve();
  /** Project-relative paths awaiting upload (normalized remote form). */
  private pendingPush = new Set<NormalizedRelPath>();
  /**
   * rev of files we just uploaded, keyed by normalized relPath. When the next
   * delta echoes our own write back, its rev matches and we skip it instead of
   * minting a spurious conflict sidecar (the file is byte-identical to local).
   */
  private pushedRevs = new Map<NormalizedRelPath, string>();
  /**
   * Flipped by `stop()`; a late pass that was already in flight when teardown
   * ran checks this before writing status or persisting state so it can't
   * resurrect a cleared badge or clobber a replacement engine's manifest.
   */
  private dead = false;
  /**
   * Consecutive drainPush failures — grows the retry delay exponentially so a
   * permanently failing upload (offline laptop, revoked token) doesn't fire a
   * network attempt and flip the badge to error every 15s forever. No terminal
   * give-up on auth-looking errors: error shapes are stringly through the
   * IPC/provider layers and a false positive would silently stop sync.
   */
  private pushFailures = 0;

  constructor(
    private readonly provider: CloudFsProvider,
    private readonly opts: SyncEngineOptions,
  ) {}

  cacheRoot(): string {
    return this.opts.cacheRoot ??
      projectCacheRoot(this.opts.projectsRoot, this.opts.providerId, this.opts.projectId);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    await this.ensureCursorLoaded();
    await this.ensureSyncStateLoaded();
    // Re-queue any local edits that diverged from sync-state while no engine
    // was running (a push dropped by a project switch, an offline save, or an
    // app quit mid-debounce). Fire-and-forget so it doesn't gate the first poll.
    void this.reconcileLocalChanges();
    void this.tick();
  }

  /**
   * Stop the engine and wait for any in-flight pull/push pass to drain, so a
   * late pass can't write status or persist cache/manifest state after teardown
   * (which would resurrect a cleared badge or race a replacement engine sharing
   * the same cache). Idempotent.
   */
  async stop(): Promise<void> {
    this.dead = true;
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.pushTimer) {
      clearTimeout(this.pushTimer);
      this.pushTimer = null;
    }
    // Drain the in-flight pass; the chain resolves even on a rejected pass.
    try {
      await this.chain;
    } catch {
      // A failing pass doesn't block teardown.
    }
    setSyncPhase(this.opts.providerId, this.opts.projectId, "idle");
  }

  /**
   * Compare each file tracked in sync-state against its recorded content hash
   * and re-queue those that diverged (or push a deletion for tracked files now
   * missing). This is the recovery path for pushes that were dropped while the
   * engine wasn't running — without it a locally-saved file whose push was lost
   * stays silently divergent until the user happens to re-save that exact file.
   */
  private async reconcileLocalChanges(): Promise<void> {
    if (!this.running) return;
    try {
      await this.ensureSyncStateLoaded();
      const diverged: NormalizedRelPath[] = [];
      for (const state of Object.values(this.syncState!.files)) {
        const abs = cachePathForRemoteRel(this.cacheRoot(), state.relPath);
        if (!(await safeExists(abs))) {
          diverged.push(state.relPath); // tracked-but-missing → deletion push
          continue;
        }
        if (!(await localMatchesState(abs, state))) diverged.push(state.relPath);
      }
      if (diverged.length > 0) this.queuePush(diverged);
    } catch (err) {
      recordError(
        "cloud-sync",
        `startup reconcile failed for ${this.opts.projectId}`,
        err,
      );
    }
  }

  async pullNow(): Promise<PullPassResult> {
    await this.ensureCursorLoaded();
    await this.ensureSyncStateLoaded();
    return this.runExclusive(() => this.pullPass());
  }

  /**
   * Populate a brand-new cache from existing remote content: download every
   * file, record its sync state (rev + content hash), and persist the
   * post-enumeration cursor. Run once at project creation, BEFORE the engine
   * starts — so the local working copy mirrors the remote and the first poll's
   * delta() continues from the cursor instead of replaying the whole tree as
   * conflicts against a planted starter. Returns the number of files seeded.
   */
  async seedFromRemote(): Promise<number> {
    await this.ensureSyncStateLoaded();
    const { files, cursor } = await this.provider.enumerateFiles(this.opts.rootId);
    for (const file of files) {
      let normRel: string;
      try {
        normRel = normalizeRemoteRelPath(file.relPath);
      } catch {
        // Skip unsafe remote paths (traversal, .typeward, absolute) — same
        // rule the pull path enforces.
        continue;
      }
      const abs = cachePathForRemoteRel(this.cacheRoot(), normRel);
      await mkdirParents(abs);
      await this.provider.downloadFile(file, abs);
      await this.recordSyncedFile(normRel, file, abs);
    }
    this.cursor = cursor;
    await this.persistCursor(cursor);
    return files.length;
  }

  /**
   * Queue local saves for upload. Called from the save path via the
   * init-layer notifier. Internal-state paths (`.typeward/...`) throw in
   * `normalizeRemoteRelPath` and are silently skipped — they must never push.
   */
  queuePush(relPaths: string[]): void {
    if (!this.running) return;
    let added = false;
    for (const rel of relPaths) {
      let norm: NormalizedRelPath;
      try {
        norm = normalizeRemoteRelPath(rel);
      } catch {
        continue;
      }
      if (!this.pendingPush.has(norm)) {
        this.pendingPush.add(norm);
        added = true;
      }
    }
    if (!added) return;
    if (this.pushTimer) clearTimeout(this.pushTimer);
    this.pushTimer = setTimeout(() => {
      this.pushTimer = null;
      void this.drainPush();
    }, PUSH_DEBOUNCE_MS);
  }

  private runExclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.chain.then(fn, fn);
    this.chain = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runExclusive(() => this.pullPass());
    } catch (err) {
      setSyncPhase(
        this.opts.providerId,
        this.opts.projectId,
        "error",
        describeIpcError(err),
      );
    }
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  private async drainPush(): Promise<void> {
    try {
      await this.runExclusive(() => this.pushPass());
    } catch (err) {
      setSyncPhase(
        this.opts.providerId,
        this.opts.projectId,
        "error",
        describeIpcError(err),
      );
      // Leave the failed paths queued and retry on an exponential backoff
      // (base 15s, doubling to a 5-minute cap).
      const delay = Math.min(PUSH_RETRY_MS * 2 ** this.pushFailures, PUSH_RETRY_MAX_MS);
      this.pushFailures++;
      if (this.running && this.pendingPush.size > 0 && !this.pushTimer) {
        this.pushTimer = setTimeout(() => {
          this.pushTimer = null;
          void this.drainPush();
        }, delay);
      }
    }
  }

  private async pushPass(): Promise<void> {
    if (!this.running || this.pendingPush.size === 0) return;
    const batch = [...this.pendingPush];
    this.pendingPush.clear();
    setSyncPhase(this.opts.providerId, this.opts.projectId, "pushing");
    await this.ensureSyncStateLoaded();
    for (const rel of batch) {
      const abs = cachePathForRemoteRel(this.cacheRoot(), rel);
      if (!(await safeExists(abs))) {
        await this.pushDeletionIfTracked(rel);
        continue;
      }
      try {
        const remote = await pushOne(this.provider, {
          rootId: this.opts.rootId,
          relPath: rel,
          sourceAbsPath: abs,
        });
        if (remote.rev) this.pushedRevs.set(rel, remote.rev);
        await this.recordSyncedFile(rel, remote, abs);
      } catch (err) {
        // Re-queue this path and abort the batch; drainPush handles retry.
        this.pendingPush.add(rel);
        throw err;
      }
    }
    this.pushFailures = 0;
    if (this.running) {
      const conflicts = getSyncStatus(this.opts.providerId, this.opts.projectId).conflicts;
      setSyncPhase(
        this.opts.providerId,
        this.opts.projectId,
        conflicts.length > 0 ? "conflict" : "idle",
      );
    }
  }

  private async pullPass(): Promise<PullPassResult> {
    setSyncPhase(this.opts.providerId, this.opts.projectId, "pulling");

    const conflicts: string[] = [];
    let applied = 0;
    let nextCursor = this.cursor ?? "";
    // Drain every page in one pass so conflicts from all pages are recorded
    // together (a single trailing recordConflicts), not just the last page's.
    for (;;) {
      const result = await this.provider.delta(this.opts.rootId, this.cursor);
      for (const change of result.changes) {
        try {
          const conflicted = await this.applyChange(change);
          if (conflicted) conflicts.push(conflicted);
          else applied++;
        } catch (e) {
          // One unsafe/malformed remote entry (e.g. a file literally named
          // ".typeward" or carrying traversal segments) must not wedge the
          // page: refusing the write is correct, but aborting before
          // persistCursor would retry the same page forever and stall sync
          // for the whole project. Skip it and move on.
          const rel = change.kind === "removed" ? change.relPath : change.file.relPath;
          recordError("cloud-sync", `skipped unsafe remote entry ${rel}`, e);
        }
      }
      this.cursor = result.nextCursor;
      nextCursor = result.nextCursor;
      await this.persistCursor(result.nextCursor);
      if (!result.hasMore) break;
    }

    // A completed pull proves the connection works — restore the fast push retry.
    this.pushFailures = 0;

    // Skip once torn down: recordConflicts would otherwise re-insert a status
    // entry that teardown's clearSyncStatus just deleted, stranding a phantom
    // conflict badge on a closed project.
    if (!this.dead) {
      recordConflicts(this.opts.providerId, this.opts.projectId, conflicts);
    }
    if (this.running) {
      setSyncPhase(
        this.opts.providerId,
        this.opts.projectId,
        conflicts.length > 0 ? "conflict" : "idle",
      );
    }
    return { applied, conflicts, nextCursor };
  }

  private async applyChange(change: DeltaChange): Promise<string | undefined> {
    await this.ensureSyncStateLoaded();
    if (change.kind === "removed") {
      const normRel = normalizeRemoteRelPath(change.relPath);
      const abs = cachePathForRemoteRel(this.cacheRoot(), normRel);
      const localExists = await safeExists(abs);
      const synced = this.syncState?.files[normRel];
      if (localExists && synced && !(await localMatchesState(abs, synced))) {
        const conflictAbs = cachePathForRemoteRel(
          this.cacheRoot(),
          suffixWithConflict(normRel, Date.now()),
        );
        await mkdirParents(conflictAbs);
        const localBytes = await readFile(abs);
        await writeFile(conflictAbs, localBytes);
        await remove(abs);
        await this.removeSyncedFile(normRel);
        return normRel;
      }
      if (localExists) {
        try {
          await remove(abs);
        } catch {
          // Already gone — ignore.
        }
      }
      await this.removeSyncedFile(normRel);
      return undefined;
    }

    // Suppress the echo of our own upload: the provider replays the file we
    // just pushed as a remote change, but its rev matches what uploadFile
    // returned and the bytes are identical to local — applying it would write
    // a junk conflict sidecar on every save.
    // An unsafe path throws here and is skipped by pullPass's per-change
    // catch — falling back to the unnormalized string would thread an
    // unvalidated path into the sync-state writes below.
    const normRel = normalizeRemoteRelPath(change.file.relPath);
    const pushedRev = this.pushedRevs.get(normRel);
    if (pushedRev && change.file.rev && change.file.rev === pushedRev) {
      this.pushedRevs.delete(normRel);
      return undefined;
    }

    const abs = cachePathForRemoteRel(this.cacheRoot(), normRel);
    const localExists = await safeExists(abs);

    if (localExists) {
      const synced = this.syncState?.files[normRel];
      const remoteChanged = !synced?.rev || !change.file.rev || synced.rev !== change.file.rev;
      const localChanged = synced ? !(await localMatchesState(abs, synced)) : undefined;
      if (remoteChanged && localChanged === true) {
        const local = await stat(abs);
        const remoteMtime = change.file.modifiedAt
          ? Date.parse(change.file.modifiedAt)
          : 0;
        const localMtime = local.mtime ? local.mtime.getTime() : 0;
        const decision = decideConflict(normRel, localMtime, remoteMtime);
        if (decision.winner === "local") {
          // Local wins → write the remote copy to the conflict path so
          // the user can compare. Don't overwrite local.
          const conflictAbs = cachePathForRemoteRel(this.cacheRoot(), decision.conflictPath);
          await mkdirParents(conflictAbs);
          await this.provider.downloadFile(change.file, conflictAbs);
          return normRel;
        }
        // Remote wins → save the local copy aside, then overwrite local.
        const sidecarAbs = cachePathForRemoteRel(this.cacheRoot(), decision.conflictPath);
        await mkdirParents(sidecarAbs);
        const localBytes = await readFile(abs);
        await writeFile(sidecarAbs, localBytes);
      } else if (localChanged === undefined) {
        const local = await stat(abs);
        const remoteMtime = change.file.modifiedAt
          ? Date.parse(change.file.modifiedAt)
          : 0;
        const localMtime = local.mtime ? local.mtime.getTime() : 0;
        if (remoteMtime && localMtime && Math.abs(remoteMtime - localMtime) > 1000) {
          const decision = decideConflict(normRel, localMtime, remoteMtime);
          if (decision.winner === "local") {
            const conflictAbs = cachePathForRemoteRel(this.cacheRoot(), decision.conflictPath);
            await mkdirParents(conflictAbs);
            await this.provider.downloadFile(change.file, conflictAbs);
            return normRel;
          }
          const sidecarAbs = cachePathForRemoteRel(this.cacheRoot(), decision.conflictPath);
          await mkdirParents(sidecarAbs);
          const localBytes = await readFile(abs);
          await writeFile(sidecarAbs, localBytes);
        }
      }
    }

    await mkdirParents(abs);
    await this.provider.downloadFile(change.file, abs);
    await this.recordSyncedFile(normRel, change.file, abs);
    return undefined;
  }

  private async ensureCursorLoaded(): Promise<void> {
    if (this.cursor !== undefined) return;
    const path = cursorPathForCacheRoot(this.cacheRoot(), this.opts.providerId);
    try {
      this.cursor = (await readTextFile(path)).trim() || undefined;
    } catch {
      this.cursor = undefined;
    }
  }

  private async persistCursor(value: string): Promise<void> {
    const path = cursorPathForCacheRoot(this.cacheRoot(), this.opts.providerId);
    await mkdirParents(path);
    await writeTextFile(path, value);
  }

  private async ensureSyncStateLoaded(): Promise<void> {
    if (this.syncState) return;
    const path = syncStatePathForCacheRoot(this.cacheRoot(), this.opts.providerId);
    try {
      const raw = (await readTextFile(path)).trim();
      if (!raw) throw new Error("empty sync state");
      const parsed = JSON.parse(raw) as SyncStateManifest;
      this.syncState = parsed.version === 1 && parsed.files ? parsed : emptySyncState();
    } catch {
      this.syncState = emptySyncState();
    }
  }

  private async persistSyncState(): Promise<void> {
    if (!this.syncState) return;
    const path = syncStatePathForCacheRoot(this.cacheRoot(), this.opts.providerId);
    await mkdirParents(path);
    await writeTextFile(path, JSON.stringify(this.syncState, null, 2));
  }

  private async recordSyncedFile(
    rel: string,
    remote: RemoteFile,
    absPath: string,
  ): Promise<void> {
    await this.ensureSyncStateLoaded();
    const normRel = normalizeRemoteRelPath(rel);
    const signature = await fileSignature(absPath);
    this.syncState!.files[normRel] = {
      id: remote.id,
      relPath: normRel,
      rev: remote.rev,
      ...signature,
    };
    await this.persistSyncState();
  }

  private async removeSyncedFile(rel: string): Promise<void> {
    await this.ensureSyncStateLoaded();
    delete this.syncState!.files[normalizeRemoteRelPath(rel)];
    await this.persistSyncState();
  }

  private async pushDeletionIfTracked(rel: string): Promise<void> {
    await this.ensureSyncStateLoaded();
    const normRel = normalizeRemoteRelPath(rel);
    const synced = this.syncState!.files[normRel];
    if (!synced) return;
    await this.provider.deleteRemoteFile(this.opts.rootId, {
      id: synced.id,
      relPath: normRel,
      rev: synced.rev,
    });
    await this.removeSyncedFile(normRel);
  }
}

function emptySyncState(): SyncStateManifest {
  return { version: 1, files: {} };
}

async function fileSignature(absPath: string): Promise<Pick<SyncedFileState, "hash" | "size" | "mtimeMs">> {
  const [bytes, metadata] = await Promise.all([readFile(absPath), stat(absPath)]);
  return {
    hash: await sha256Hex(bytes),
    size: bytes.byteLength,
    mtimeMs: metadata.mtime ? metadata.mtime.getTime() : 0,
  };
}

async function localMatchesState(absPath: string, state: SyncedFileState): Promise<boolean> {
  const signature = await fileSignature(absPath);
  return signature.hash === state.hash && signature.size === state.size;
}

/**
 * SHA-256 of the file bytes, hex. A wide cryptographic digest so conflict
 * detection can't be fooled by a collision — remote content is attacker-
 * controlled in the threat model, and a narrow 32-bit hash could be crafted to
 * collide (same hash + size) with a local edit and silently hide it. (Persisted
 * pre-upgrade FNV hashes simply mismatch once and the file is conservatively
 * re-evaluated as changed — never the other way around.)
 */
async function sha256Hex(bytes: Uint8Array): Promise<string> {
  // crypto.subtle.digest wants an ArrayBuffer-backed BufferSource; the lib
  // types model a bare Uint8Array as possibly SharedArrayBuffer-backed. Tauri's
  // readFile always returns a plain (non-shared) buffer, so the narrow is safe.
  const digest = await crypto.subtle.digest("SHA-256", bytes as Uint8Array<ArrayBuffer>);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function mkdirParents(absPath: string): Promise<void> {
  const lastSep = Math.max(absPath.lastIndexOf("/"), absPath.lastIndexOf("\\"));
  if (lastSep <= 0) return;
  const dir = absPath.slice(0, lastSep);
  try {
    await mkdir(dir, { recursive: true });
  } catch {
    // Race on parallel changes is benign.
  }
}

async function safeExists(absPath: string): Promise<boolean> {
  try {
    return await exists(absPath);
  } catch {
    return false;
  }
}

// Upload one local file. Driven by `SyncEngine.pushPass` off the queue that
// the save path feeds via the init-layer notifier.
export interface PushPlan {
  rootId: string;
  relPath: string;
  sourceAbsPath: string;
}

export async function pushOne(provider: CloudFsProvider, plan: PushPlan): Promise<RemoteFile> {
  return provider.uploadFile(
    plan.rootId,
    normalizeRemoteRelPath(plan.relPath),
    plan.sourceAbsPath,
  );
}
