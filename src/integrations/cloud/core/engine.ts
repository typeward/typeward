/**
 * Sync engine — orchestrates pull / push / delta for a single
 * (provider, project) pair.
 *
 * Phase 2.1 ships the scaffold: lifecycle, status hooks, conflict
 * detection, cursor persistence. Provider-specific transport details
 * (enumeration, delta derivation, poll cadence) arrive with each provider.
 */

import { createSignal } from "solid-js";

import { describeIpcError } from "~/lib/errors";
import {
  exists,
  mkdir,
  readFile,
  readTextFile,
  remove,
  rename,
  stat,
  writeFile,
  writeTextFile,
} from "@tauri-apps/plugin-fs";
import { nanoid } from "nanoid";

import type { CloudFsProvider, DeltaChange, RemoteFile } from "~/integrations/types";
import { recordError } from "~/lib/telemetry";
import { notifyError } from "~/lib/toast";

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

/**
 * Transport-shaped failures (reqwest strings crossing the IPC verbatim) are
 * retried by the engine's own poll/backoff loops — the badge shows them as a
 * neutral "Offline — will retry" instead of a red raw-string error. Anything
 * unmatched stays a real error.
 */
function isNetworkShapedError(detail: string): boolean {
  const d = detail.toLowerCase();
  return (
    d.includes("error sending request") ||
    d.includes("connection refused") ||
    d.includes("connection reset") ||
    d.includes("timed out") ||
    d.includes("timeout") ||
    d.includes("dns error") ||
    d.includes("failed to lookup") ||
    d.includes("no such host") ||
    d.includes("network is unreachable") ||
    d.includes("host unreachable")
  );
}

/**
 * One-shot intent raised by the conflict toast's Resolve action; the
 * SyncStatusBadge (which owns the ConflictResolverDialog) reacts to it. Lives
 * here rather than in the badge so engine-layer code never imports a
 * component module.
 */
const [conflictResolverIntent, setConflictResolverIntent] = createSignal(0);
export { conflictResolverIntent };
export function requestConflictResolver(): void {
  setConflictResolverIntent((n) => n + 1);
}

export interface SyncEngineOptions {
  providerId: string;
  projectId: string;
  /** Provider-side identifier of the remote root folder backing this project. */
  rootId: string;
  /** User's Typeward projects root — usually `~/Documents/Typeward`. */
  projectsRoot: string;
  /** Actual local project/cache root opened by the editor. */
  cacheRoot?: string;
  /** Default poll interval; providers can override per call. */
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
// Aborted replays of one delta page tolerated before it's processed in
// salvage mode (failing entries become persisted pending-retries and the
// cursor advances past the page).
const PULL_PAGE_MAX_ATTEMPTS = 3;

interface SyncedFileState {
  id: string;
  relPath: NormalizedRelPath;
  rev?: string;
  hash: string;
  size: number;
  mtimeMs: number;
}

interface PendingRetryEntry {
  relPath: NormalizedRelPath;
  /** Human-readable apply-failure reason, surfaced in the sync badge. */
  reason: string;
  /** Remote snapshot to re-download for a failed write; absent for deletions. */
  file?: RemoteFile;
  /** Provider id of the removed entry when the failed change was a deletion. */
  removedId?: string;
}

interface SyncStateManifest {
  version: 1;
  files: Record<string, SyncedFileState>;
  /**
   * Changes whose local apply kept failing after their page went into salvage
   * mode (e.g. a remote file named `aux.tex` that Windows refuses to create).
   * Retried at the start of every pull pass. Optional so manifests written
   * before this field existed keep loading.
   */
  pendingRetries?: Record<string, PendingRetryEntry>;
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
  /**
   * Consecutive aborted attempts of the delta page fetched at a given cursor.
   * The first PULL_PAGE_MAX_ATTEMPTS failures abort without advancing the
   * cursor so transients never lose a revision; after that the page runs in
   * salvage mode. In-memory on purpose — a restart earns the page a fresh set
   * of transient-friendly attempts.
   */
  private pageFailure: { cursor: string | null; attempts: number } | null = null;

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

  /** Route a failed pass to the badge: transient network shapes read as a
   *  neutral offline state, everything else as a real error. */
  private reportPassFailure(err: unknown): void {
    const detail = describeIpcError(err);
    setSyncPhase(
      this.opts.providerId,
      this.opts.projectId,
      isNetworkShapedError(detail) ? "offline" : "error",
      detail,
    );
  }

  /**
   * Record newly-detected conflicts and, on the 0 -> N transition only, raise
   * a one-shot toast (the badge itself deliberately stays non-live — see its
   * comment). Later passes that add MORE conflicts stay quiet: the badge
   * already shows the count.
   */
  private recordConflictsWithNotice(conflicts: string[]): void {
    if (conflicts.length === 0) return;
    const prevCount = getSyncStatus(
      this.opts.providerId,
      this.opts.projectId,
    ).conflicts.length;
    recordConflicts(this.opts.providerId, this.opts.projectId, conflicts);
    if (prevCount > 0) return;
    const [first] = conflicts;
    const rest = conflicts.length - 1;
    notifyError(
      `Sync conflict in "${first}"`,
      rest > 0
        ? `Both this device and the cloud copy changed (and ${rest} more file${rest === 1 ? "" : "s"}). The other version is kept beside yours.`
        : "Both this device and the cloud copy changed. The other version is kept beside yours.",
      { label: "Resolve", run: requestConflictResolver },
    );
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.runExclusive(() => this.pullPass());
    } catch (err) {
      this.reportPassFailure(err);
    }
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  private async drainPush(): Promise<void> {
    try {
      await this.runExclusive(() => this.pushPass());
    } catch (err) {
      this.reportPassFailure(err);
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
    // Snapshot + pre-clear (not delete-per-success) so a queuePush for a path
    // whose stale upload is in flight re-adds it to the emptied set and
    // re-arms the debounce for the newer save.
    const batch = [...this.pendingPush];
    this.pendingPush.clear();
    setSyncPhase(this.opts.providerId, this.opts.projectId, "pushing");
    await this.ensureSyncStateLoaded();
    // Attempt every item — one permanently failing upload (an oversized file,
    // a provider-rejected name) must not head-of-line-block the rest of the
    // queue. Only the failed items re-queue; the aggregate rethrow still arms
    // drainPush's backoff.
    const failures: { rel: NormalizedRelPath; err: unknown }[] = [];
    for (const rel of batch) {
      try {
        const abs = cachePathForRemoteRel(this.cacheRoot(), rel);
        if (!(await safeExists(abs))) {
          await this.pushDeletionIfTracked(rel);
          continue;
        }
        // Send the revision we last synced so the server refuses the write if
        // someone else changed the file since. Without it the PUT is
        // unconditional: another device's edit is replaced, and echo
        // suppression matches our own new rev on the next delta, so the loss is
        // never even detected — no `.conflict-*` sidecar, contradicting the
        // engine's own preserve-the-loser guarantee. A file we have never
        // synced has no rev and stays a plain create.
        const remote = await pushOne(this.provider, {
          rootId: this.opts.rootId,
          relPath: rel,
          sourceAbsPath: abs,
          expectedRev: this.syncState?.files[rel]?.rev,
        });
        if (remote.rev) this.pushedRevs.set(rel, remote.rev);
        await this.recordSyncedFile(rel, remote, abs);
      } catch (err) {
        failures.push({ rel, err });
      }
    }
    if (failures.length > 0) {
      for (const failure of failures) this.pendingPush.add(failure.rel);
      const listed = failures.slice(0, 3).map((f) => f.rel).join(", ");
      const rest = failures.length > 3 ? ` and ${failures.length - 3} more` : "";
      throw new Error(
        `Upload failed for ${listed}${rest}: ${describeIpcError(failures[0].err)}`,
      );
    }
    this.pushFailures = 0;
    this.settlePhaseAfterPass();
  }

  private async pullPass(): Promise<PullPassResult> {
    setSyncPhase(this.opts.providerId, this.opts.projectId, "pulling");
    await this.ensureSyncStateLoaded();

    const conflicts: string[] = [];
    let applied = 0;
    let nextCursor = this.cursor ?? "";
    // Drain every page in one pass so conflicts from all pages are recorded
    // together (a single trailing recordConflicts), not just the last page's.
    try {
      applied += await this.retryPendingChanges(conflicts);
      for (;;) {
        const pageCursor = this.cursor ?? null;
        const salvage =
          this.pageFailure !== null &&
          this.pageFailure.cursor === pageCursor &&
          this.pageFailure.attempts >= PULL_PAGE_MAX_ATTEMPTS;
        const result = await this.provider.delta(this.opts.rootId, this.cursor);
        for (const change of result.changes) {
          const rel = change.kind === "removed" ? change.relPath : change.file.relPath;
          let normRel: NormalizedRelPath;
          try {
            normRel = normalizeRemoteRelPath(rel);
          } catch (e) {
            // One unsafe/malformed remote entry (e.g. a file literally named
            // ".typeward" or carrying traversal segments) must not wedge the
            // page: refusing the write is correct, but aborting before
            // persistCursor would retry the same page forever and stall sync
            // for the whole project. Skip it and move on.
            recordError("cloud-sync", `skipped unsafe remote entry ${rel}`, e);
            continue;
          }
          try {
            const conflicted = await this.applyChange(change);
            if (conflicted) conflicts.push(conflicted);
            else applied++;
          } catch (err) {
            // An operational failure (download, disk, sync-state write) aborts
            // the page — the cursor stays at the last good page and the next
            // pull replays the missed revision — until the SAME page has
            // aborted PULL_PAGE_MAX_ATTEMPTS times. Then it runs in salvage
            // mode: the failing entry becomes a persisted pending-retry and
            // the page completes, so one deterministically-poisoned file
            // (e.g. a remote `aux.tex` on Windows) can't wedge the whole
            // project's sync forever.
            if (!salvage) {
              this.notePageFailure(pageCursor);
              throw err;
            }
            await this.recordPendingRetry(normRel, change, err);
          }
        }
        this.pageFailure = null;
        this.cursor = result.nextCursor;
        nextCursor = result.nextCursor;
        await this.persistCursor(result.nextCursor);
        if (!result.hasMore) break;
      }
    } catch (err) {
      // Pages completed before the failure already advanced the cursor and
      // never replay — surface their conflict sidecars before bailing.
      if (!this.dead && conflicts.length > 0) {
        this.recordConflictsWithNotice(conflicts);
      }
      throw err;
    }

    // A completed pull proves the connection works — restore the fast push retry.
    this.pushFailures = 0;

    // Skip once torn down: recordConflicts would otherwise re-insert a status
    // entry that teardown's clearSyncStatus just deleted, stranding a phantom
    // conflict badge on a closed project.
    if (!this.dead) {
      this.recordConflictsWithNotice(conflicts);
      this.settlePhaseAfterPass();
    }
    return { applied, conflicts, nextCursor };
  }

  private notePageFailure(pageCursor: string | null): void {
    this.pageFailure =
      this.pageFailure && this.pageFailure.cursor === pageCursor
        ? { cursor: pageCursor, attempts: this.pageFailure.attempts + 1 }
        : { cursor: pageCursor, attempts: 1 };
  }

  /**
   * Re-attempt every persisted pending-retry entry by re-applying the stored
   * change (a fresh download for writes — latest content is fine — or the
   * deferred deletion). Success removes the entry; failure keeps it, per
   * entry, so one still-poisoned path can't block the others or the pass.
   * Returns how many entries applied cleanly.
   */
  private async retryPendingChanges(conflicts: string[]): Promise<number> {
    await this.ensureSyncStateLoaded();
    const pending = this.syncState!.pendingRetries;
    if (!pending) return 0;
    let applied = 0;
    let changed = false;
    for (const entry of Object.values(pending)) {
      const change: DeltaChange = entry.file
        ? { kind: "modified", file: entry.file }
        : { kind: "removed", relPath: entry.relPath, id: entry.removedId };
      try {
        const conflicted = await this.applyChange(change);
        if (conflicted) conflicts.push(conflicted);
        else applied++;
        delete pending[entry.relPath];
        changed = true;
      } catch (err) {
        const reason = describeIpcError(err);
        if (entry.reason !== reason) {
          entry.reason = reason;
          changed = true;
        }
      }
    }
    if (changed) await this.persistSyncState();
    return applied;
  }

  private async recordPendingRetry(
    normRel: NormalizedRelPath,
    change: DeltaChange,
    err: unknown,
  ): Promise<void> {
    await this.ensureSyncStateLoaded();
    const pending = (this.syncState!.pendingRetries ??= {});
    pending[normRel] = {
      relPath: normRel,
      reason: describeIpcError(err),
      ...(change.kind === "removed" ? { removedId: change.id } : { file: change.file }),
    };
    recordError("cloud-sync", `deferred failing remote entry ${normRel} for retry`, err);
    await this.persistSyncState();
  }

  /**
   * Resting phase after a completed pass: unresolved conflicts win, then any
   * persisted pending-retries surface as a visible error (a pass that had to
   * salvage entries must never read as cleanly synced), then idle.
   */
  private settlePhaseAfterPass(): void {
    if (!this.running) return;
    const conflicts = getSyncStatus(this.opts.providerId, this.opts.projectId).conflicts;
    if (conflicts.length > 0) {
      setSyncPhase(this.opts.providerId, this.opts.projectId, "conflict");
      return;
    }
    const pending = Object.values(this.syncState?.pendingRetries ?? {});
    if (pending.length > 0) {
      setSyncPhase(
        this.opts.providerId,
        this.opts.projectId,
        "error",
        pendingRetrySummary(pending),
      );
      return;
    }
    setSyncPhase(this.opts.providerId, this.opts.projectId, "idle");
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
    // An unsafe path throws here (pullPass pre-validates and skips such
    // entries before applying) — falling back to the unnormalized string
    // would thread an unvalidated path into the sync-state writes below.
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
      if (!remoteChanged) {
        // Already reconciled at this exact rev — e.g. a replayed page after a
        // local-wins decision recorded the remote rev against the local bytes.
        // Re-downloading would clobber the local winner with remote content.
        return undefined;
      }
      const localChanged = synced ? !(await localMatchesState(abs, synced)) : undefined;
      if (localChanged === true) {
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
          // Adopt the remote rev against the LOCAL bytes so a replayed page
          // sees this change as already reconciled instead of minting another
          // sidecar; the explicit queuePush still sends the local winner up.
          await this.recordSyncedFile(normRel, change.file, abs);
          this.queuePush([normRel]);
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
            await this.recordSyncedFile(normRel, change.file, abs);
            this.queuePush([normRel]);
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
    await atomicWriteText(path, value);
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
    await atomicWriteText(path, JSON.stringify(this.syncState, null, 2));
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

function pendingRetrySummary(pending: PendingRetryEntry[]): string {
  const paths = pending.map((p) => p.relPath);
  const listed = paths.slice(0, 3).join(", ");
  const rest = paths.length > 3 ? ` and ${paths.length - 3} more` : "";
  const count = `${paths.length} file${paths.length === 1 ? "" : "s"}`;
  return `${count} couldn't be synced and will be retried: ${listed}${rest} (${pending[0].reason})`;
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

/**
 * Atomic text write: write to a unique temp sibling then rename over the
 * target. A crash/power-loss mid-write must never leave a torn file — a
 * truncated sync cursor or sync-state manifest silently wedges delta sync
 * (the cursor is an opaque provider token, so a partial value can't be
 * validated on read; atomicity is the only guard). rename over an existing
 * file is atomic on the same filesystem.
 */
async function atomicWriteText(absPath: string, content: string): Promise<void> {
  await mkdirParents(absPath);
  const tmp = `${absPath}.${nanoid(8)}.tmp`;
  await writeTextFile(tmp, content);
  try {
    await rename(tmp, absPath);
  } catch (e) {
    await remove(tmp).catch(() => {});
    throw e;
  }
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
  /** Last synced remote revision for this path, when one is known. */
  expectedRev?: string;
}

export async function pushOne(provider: CloudFsProvider, plan: PushPlan): Promise<RemoteFile> {
  return provider.uploadFile(
    plan.rootId,
    normalizeRemoteRelPath(plan.relPath),
    plan.sourceAbsPath,
    plan.expectedRev,
  );
}
