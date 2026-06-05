/**
 * Build a CloudFsProvider from a stored account ref.
 *
 * Used in two places:
 *   1. The new-project flow — turn the user's pick from the cloud
 *      account list into a working provider so we can call
 *      `listRoots()` / `enumerateFiles(rootId)`.
 *   2. The on-open engine lifecycle — when a project carries
 *      `integrations.cloudOrigin`, look up the matching account and
 *      instantiate a provider before starting the SyncEngine.
 *
 * Both call sites consume the same factory so the wiring stays in one
 * place.
 */

import type { Project } from "~/adapters/types";
import {
  createDropboxProvider,
  type DropboxAccount,
} from "~/integrations/cloud/dropbox";
import {
  createGoogleDriveProvider,
  type GoogleAccount,
} from "~/integrations/cloud/gdrive";
import {
  createOneDriveProvider,
  type MicrosoftAccount,
} from "~/integrations/cloud/onedrive";
import {
  idMapPath,
  idMapPathForCacheRoot,
  projectCacheRoot,
} from "~/integrations/cloud/core";
import type { CloudFsProvider } from "~/integrations/types";

export type CloudProviderId = "dropbox" | "onedrive" | "gdrive";

export interface CloudAccountRef {
  provider: CloudProviderId;
  accountId: string;
  /** Cached display label (email or "Display Name"). */
  label?: string;
}

/**
 * Build a provider for the given account. Throws for unknown
 * provider ids — defensive guard for storage that pre-dates a code
 * change.
 */
export function cloudProviderForAccount(
  ref: CloudAccountRef,
  options: { projectsRoot: string; projectId?: string; cacheRoot?: string },
): CloudFsProvider {
  switch (ref.provider) {
    case "dropbox":
      return createDropboxProvider(asDropbox(ref));
    case "onedrive":
      return createOneDriveProvider(asMicrosoft(ref));
    case "gdrive": {
      if (!options.projectId) {
        throw new Error(
          "Google Drive provider needs a projectId to anchor its id↔path map",
        );
      }
      return createGoogleDriveProvider(asGoogle(ref), {
        idMapPath: options.cacheRoot
          ? idMapPathForCacheRoot(options.cacheRoot, ref.provider)
          : idMapPath(options.projectsRoot, ref.provider, options.projectId),
      });
    }
    default: {
      const _exhaust: never = ref.provider;
      throw new Error(`Unknown cloud provider id '${_exhaust as string}'`);
    }
  }
}

export function cacheRootForCloudProject(
  projectsRoot: string,
  ref: CloudAccountRef,
  projectId: string,
): string {
  return projectCacheRoot(projectsRoot, ref.provider, projectId);
}

/**
 * Pull the cloud account ref off the project's persisted integrations
 * block, if any. The project carries provider + remote rootId; the
 * account credentials live in the user's IntegrationsSettings.
 */
export function readCloudOrigin(project: Project): {
  provider: CloudProviderId;
  accountId: string;
  remotePath: string;
} | null {
  const origin = project.integrations?.cloudOrigin;
  if (!origin) return null;
  if (origin.provider !== "dropbox" && origin.provider !== "onedrive" && origin.provider !== "gdrive") {
    return null;
  }
  return {
    provider: origin.provider,
    accountId: origin.accountId,
    remotePath: origin.remotePath,
  };
}

// Coerce the lightweight CloudAccountRef into each provider's richer
// account type. Only the id matters for the provider's HTTP path; the
// display fields are cosmetics that surface in the provider's
// displayName. Acceptable to default `email` to label or accountId when
// the settings ref lost it.

function asDropbox(ref: CloudAccountRef): DropboxAccount {
  return {
    accountId: ref.accountId,
    email: ref.label ?? ref.accountId,
    displayName: ref.label ?? ref.accountId,
  };
}

function asMicrosoft(ref: CloudAccountRef): MicrosoftAccount {
  return {
    accountId: ref.accountId,
    email: ref.label ?? ref.accountId,
    displayName: ref.label ?? ref.accountId,
  };
}

function asGoogle(ref: CloudAccountRef): GoogleAccount {
  return {
    accountId: ref.accountId,
    email: ref.label ?? ref.accountId,
    displayName: ref.label ?? ref.accountId,
  };
}
