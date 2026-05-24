/**
 * Cloud sync lifecycle. Mounts a `SyncEngine` for the active project
 * whenever the project carries `integrations.cloudOrigin`, and tears
 * it down on project close.
 *
 * Wired once at boot from `App.tsx` alongside `initReferenceProviders()`.
 */

import { createEffect, createRoot } from "solid-js";

import { hasEntitlement } from "~/integrations/entitlements";
import { project } from "~/stores/editor-store";
import { integrationsSettings, projectsRoot } from "~/stores/settings-store";

import { SyncEngine, clearSyncStatus } from "./core";
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
}

let active: ActiveEngine | null = null;

export function initCloudSync(): void {
  createRoot(() => {
    createEffect(() => {
      const proj = project();
      const root = projectsRoot();
      if (!proj || !root) {
        teardown();
        return;
      }

      const origin = readCloudOrigin(proj);
      if (!origin) {
        teardown();
        return;
      }
      if (!hasEntitlement(`integrations.cloud.${origin.provider}`)) {
        teardown();
        return;
      }

      const accountRef = findAccount(origin.provider, origin.accountId);
      if (!accountRef) {
        // The project remembers a binding for an account we no longer
        // have credentials for. Don't crash — leave the project usable
        // as a plain local folder until the user reconnects.
        teardown();
        return;
      }

      const projectId = deriveProjectId(proj.rootPath);
      // If the same engine is already running for this project, leave it.
      if (active?.providerId === accountRef.provider && active.projectId === projectId) return;

      teardown();

      const provider = cloudProviderForAccount(accountRef, {
        projectsRoot: root,
        projectId,
      });
      const engine = new SyncEngine(provider, {
        providerId: provider.id,
        projectId,
        rootId: origin.remotePath,
        projectsRoot: root,
      });
      void engine.start();
      active = { engine, providerId: provider.id, projectId };
    });
  });
}

function teardown(): void {
  if (!active) return;
  active.engine.stop();
  clearSyncStatus(active.providerId, active.projectId);
  active = null;
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
