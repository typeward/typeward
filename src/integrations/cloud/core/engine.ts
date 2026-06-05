/**
 * Sync engine — orchestrates pull / push / delta for a single
 * (provider, project) pair.
 *
 * Phase 2.1 ships the scaffold: lifecycle, status hooks, conflict
 * detection, cursor persistence. Provider-specific transport details
 * (longpoll cadence for Dropbox, polling cadence for OneDrive/Drive)
 * arrive with each provider in 2.2–2.4.
 */

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

import { decideConflict } from "./conflict";
import {
  cachePathForRemoteRel,
  cursorPathForCacheRoot,
  normalizeRemoteRelPath,
  projectCacheRoot,
} from "./paths";
import {
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

export class SyncEngine {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private running = false;
  private cursor: string | undefined;

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
    void this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    setSyncPhase(this.opts.providerId, this.opts.projectId, "idle");
  }

  async pullNow(): Promise<PullPassResult> {
    await this.ensureCursorLoaded();
    return this.pullPass();
  }

  private async tick(): Promise<void> {
    if (!this.running) return;
    try {
      await this.pullPass();
    } catch (err) {
      setSyncPhase(
        this.opts.providerId,
        this.opts.projectId,
        "error",
        err instanceof Error ? err.message : String(err),
      );
    }
    if (!this.running) return;
    this.timer = setTimeout(() => void this.tick(), this.opts.pollIntervalMs ?? DEFAULT_POLL_MS);
  }

  private async pullPass(): Promise<PullPassResult> {
    setSyncPhase(this.opts.providerId, this.opts.projectId, "pulling");
    const result = await this.provider.delta(this.opts.rootId, this.cursor);

    const conflicts: string[] = [];
    let applied = 0;
    for (const change of result.changes) {
      const conflicted = await this.applyChange(change);
      if (conflicted) conflicts.push(conflicted);
      else applied++;
    }

    this.cursor = result.nextCursor;
    await this.persistCursor(result.nextCursor);

    if (result.hasMore) {
      // Provider says there's another page — drain it immediately so we
      // converge before the next poll tick.
      const more = await this.pullPass();
      return {
        applied: applied + more.applied,
        conflicts: [...conflicts, ...more.conflicts],
        nextCursor: more.nextCursor,
      };
    }

    recordConflicts(this.opts.providerId, this.opts.projectId, conflicts);
    setSyncPhase(this.opts.providerId, this.opts.projectId, conflicts.length > 0 ? "conflict" : "idle");
    return { applied, conflicts, nextCursor: result.nextCursor };
  }

  private async applyChange(change: DeltaChange): Promise<string | undefined> {
    if (change.kind === "removed") {
      const abs = cachePathForRemoteRel(this.cacheRoot(), change.relPath);
      try {
        await remove(abs);
      } catch {
        // Already gone — ignore.
      }
      return undefined;
    }

    const abs = cachePathForRemoteRel(this.cacheRoot(), change.file.relPath);
    const localExists = await safeExists(abs);

    if (localExists) {
      const local = await stat(abs);
      const remoteMtime = change.file.modifiedAt
        ? Date.parse(change.file.modifiedAt)
        : 0;
      const localMtime = local.mtime ? local.mtime.getTime() : 0;
      if (remoteMtime && localMtime && Math.abs(remoteMtime - localMtime) > 1000) {
        const decision = decideConflict(change.file.relPath, localMtime, remoteMtime);
        if (decision.winner === "local") {
          // Local wins → write the remote copy to the conflict path so
          // the user can compare. Don't overwrite local.
          const conflictAbs = cachePathForRemoteRel(this.cacheRoot(), decision.conflictPath);
          await mkdirParents(conflictAbs);
          await this.provider.downloadFile(change.file, conflictAbs);
          return change.file.relPath;
        }
        // Remote wins → save the local copy aside, then overwrite local.
        const sidecarAbs = cachePathForRemoteRel(this.cacheRoot(), decision.conflictPath);
        await mkdirParents(sidecarAbs);
        const localBytes = await readFile(abs);
        await writeFile(sidecarAbs, localBytes);
      }
    }

    await mkdirParents(abs);
    await this.provider.downloadFile(change.file, abs);
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

// Push-side push-queue stub for Phase 2.1 — providers will hook into the
// existing autosave bus once they land. Stubbed here so the public
// surface is stable: callers can already `await engine.pushFile(...)`.
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
