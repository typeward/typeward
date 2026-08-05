/**
 * Cloud sync lifecycle. Mounts a `SyncEngine` for the active project
 * whenever the project carries `integrations.cloudOrigin`, and tears
 * it down on project close.
 *
 * Wired once at boot from `App.tsx` alongside `initReferenceProviders()`.
 */

import { createEffect, createRoot } from "solid-js";

import { project } from "~/stores/editor-store";
import { integrationsSettings, projectsRoot } from "~/stores/settings-store";

import { SyncEngine, clearSyncStatus, setSyncPhase } from "./core";
import {
  cloudProviderForAccount,
  readCloudOrigin,
  type CloudAccountRef,
  type CloudProviderId,
} from "./registry";

interface ActiveEngine {
  engine: SyncEngine;
  providerId: string;
  projectId: string;
  accountId: string;
  rootId: string;
  cacheRoot: string;
}

/** The plain, non-reactive description of the engine the current project wants. */
interface EngineTarget {
  accountRef: CloudAccountRef;
  projectId: string;
  rootId: string;
  cacheRoot: string;
  projectsRoot: string;
}

/**
 * A cloud-bound project whose engine cannot start — the account it remembers
 * has no credentials on this machine. Distinguished from a plain local
 * project (null) so the badge can say "sync is off" instead of silently
 * unmounting — before this, "syncing" and "silently not syncing" looked
 * identical.
 */
interface DisconnectedTarget {
  disconnected: true;
  providerId: CloudProviderId;
  projectId: string;
}

const PROVIDER_LABEL: Record<CloudProviderId, string> = {
  webdav: "WebDAV",
};

let active: ActiveEngine | null = null;
/** The (provider, project) whose "disconnected" status we minted, if any. */
let disconnectedShown: { providerId: string; projectId: string } | null = null;
/**
 * Serializes teardown→start across effect runs. Because `SyncEngine.stop()` is
 * now async (it drains the in-flight pass so a late write can't clobber the
 * replacement), constructing the next engine synchronously in the effect body
 * would let two engines briefly share the same cache/cursor/manifest. Chaining
 * every reconcile onto this promise guarantees the previous engine has fully
 * drained before its successor starts.
 */
let lifecycle: Promise<void> = Promise.resolve();

export function initCloudSync(): void {
  createRoot(() => {
    createEffect(() => {
      // Read every reactive dependency synchronously, then hand a plain target
      // (or null) to the serialized async reconcile.
      const target = computeTarget();
      lifecycle = lifecycle.then(() => reconcile(target)).catch(() => {});
    });
  });
}

function computeTarget(): EngineTarget | DisconnectedTarget | null {
  const proj = project();
  const root = projectsRoot();
  if (!proj || !root) return null;

  const origin = readCloudOrigin(proj);
  if (!origin) return null;

  const accountRef = findAccount(origin.provider, origin.accountId);
  if (!accountRef) {
    // The project remembers a binding for an account we no longer have
    // credentials for. Don't crash — leave the project usable as a plain
    // local folder until the user reconnects.
    return {
      disconnected: true,
      providerId: origin.provider,
      projectId: deriveProjectId(proj.rootPath),
    };
  }

  return {
    accountRef,
    projectId: deriveProjectId(proj.rootPath),
    rootId: origin.remotePath,
    cacheRoot: proj.rootPath,
    projectsRoot: root,
  };
}

async function reconcile(
  target: EngineTarget | DisconnectedTarget | null,
): Promise<void> {
  if (!target) {
    await teardown();
    clearDisconnected();
    return;
  }
  if ("disconnected" in target) {
    await teardown();
    showDisconnected(target);
    return;
  }
  clearDisconnected();
  // If the same engine is already running for this project, leave it.
  if (
    active?.providerId === target.accountRef.provider &&
    active.projectId === target.projectId &&
    active.accountId === target.accountRef.accountId &&
    active.rootId === target.rootId &&
    active.cacheRoot === target.cacheRoot
  ) {
    return;
  }

  await teardown();

  const provider = cloudProviderForAccount(target.accountRef);
  const engine = new SyncEngine(provider, {
    providerId: provider.id,
    projectId: target.projectId,
    rootId: target.rootId,
    projectsRoot: target.projectsRoot,
    cacheRoot: target.cacheRoot,
  });
  active = {
    engine,
    providerId: provider.id,
    projectId: target.projectId,
    accountId: target.accountRef.accountId,
    rootId: target.rootId,
    cacheRoot: target.cacheRoot,
  };
  void engine.start();
}

/**
 * Push local saves to the cloud. Called from the save path (`saveActiveFile`
 * / `saveAllDirtyFiles`) after a successful write. No-ops unless the saved
 * project is the one backed by the currently-active sync engine, so saves to
 * plain local projects cost nothing.
 *
 * `cacheRoot` is the saved project's `rootPath`; `relPaths` are
 * project-relative. NOT called from the snapshot autosave — that writes
 * `.typeward/` sidecars, which must never sync.
 */
export function notifyLocalSave(cacheRoot: string, relPaths: string[]): void {
  if (!active || active.cacheRoot !== cacheRoot || relPaths.length === 0) return;
  active.engine.queuePush(relPaths);
}

function showDisconnected(target: DisconnectedTarget): void {
  const label = PROVIDER_LABEL[target.providerId] ?? target.providerId;
  // Replace a stale entry for a different project before minting the new one.
  if (
    disconnectedShown &&
    (disconnectedShown.providerId !== target.providerId ||
      disconnectedShown.projectId !== target.projectId)
  ) {
    clearDisconnected();
  }
  setSyncPhase(
    target.providerId,
    target.projectId,
    "disconnected",
    `${label} isn't connected on this machine — reconnect it in Settings to resume syncing. Your files stay safe locally.`,
  );
  disconnectedShown = {
    providerId: target.providerId,
    projectId: target.projectId,
  };
}

function clearDisconnected(): void {
  if (!disconnectedShown) return;
  clearSyncStatus(disconnectedShown.providerId, disconnectedShown.projectId);
  disconnectedShown = null;
}

async function teardown(): Promise<void> {
  const current = active;
  if (!current) return;
  // Clear the reference first so notifyLocalSave can't queue onto a dying
  // engine while we await its drain.
  active = null;
  await current.engine.stop();
  clearSyncStatus(current.providerId, current.projectId);
}

function findAccount(
  provider: CloudProviderId,
  accountId: string,
): CloudAccountRef | undefined {
  const acc = integrationsSettings().cloud.accounts.find(
    (a) => a.provider === provider && a.accountId === accountId,
  );
  if (!acc) return undefined;
  return {
    provider: acc.provider as CloudProviderId,
    accountId: acc.accountId,
    label: acc.label,
    baseUrl: acc.baseUrl,
    username: acc.username,
    allowPrivateHost: acc.allowPrivateHost,
  };
}

/**
 * Project id under the cache directory is the final path segment. We
 * use that as the engine key so engines from different projects don't
 * collide in the per-(provider, project) status store.
 */
function deriveProjectId(rootPath: string): string {
  const trimmed = rootPath.replace(/[\\/]+$/, "");
  const lastSep = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return lastSep >= 0 ? trimmed.slice(lastSep + 1) : trimmed;
}
