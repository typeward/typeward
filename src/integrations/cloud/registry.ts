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
  createWebdavProvider,
  type WebdavAccount,
} from "~/integrations/cloud/webdav";
import { projectCacheRoot } from "~/integrations/cloud/core";
import type { CloudFsProvider } from "~/integrations/types";

export type CloudProviderId = "dropbox" | "webdav";

/**
 * Registry idiom (cloud): unlike references (open reactive list) and AI
 * (single-active union + lazy map), cloud has no long-lived registry — this is
 * a per-account factory with an exhaustive `switch`, because a provider is
 * instantiated on demand per active project.
 *
 * NOTE: `baseUrl`/`username`/`allowPrivateHost` are WebDAV-only and sit here as
 * optionals with an `asWebdav` runtime throw. The clean shape is a discriminated
 * union on `provider`, but the construction/copy sites live in cloud/init.ts and
 * cloud/create.ts (not owned by this change); tightening is deferred to a pass
 * that can touch those together.
 */
export interface CloudAccountRef {
  provider: CloudProviderId;
  accountId: string;
  /** Cached display label (email or "Display Name"). */
  label?: string;
  // WebDAV-only: the server URL + username needed to rebuild the provider
  // (the password is in the keyring). Absent for OAuth providers.
  baseUrl?: string;
  username?: string;
  allowPrivateHost?: boolean;
}

/**
 * Build a provider for the given account. Throws for unknown
 * provider ids — defensive guard for storage that pre-dates a code
 * change.
 */
export function cloudProviderForAccount(ref: CloudAccountRef): CloudFsProvider {
  switch (ref.provider) {
    case "dropbox":
      return createDropboxProvider(asDropbox(ref));
    case "webdav":
      return createWebdavProvider(asWebdav(ref));
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
  if (origin.provider !== "dropbox" && origin.provider !== "webdav") {
    return null;
  }
  return {
    provider: origin.provider as CloudProviderId,
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

// WebDAV needs the server URL + username (the password is in the keyring). The
// settings account ref carries them; if a pre-existing ref lost them the user
// must reconnect.
function asWebdav(ref: CloudAccountRef): WebdavAccount {
  if (!ref.baseUrl || !ref.username) {
    throw new Error(
      "WebDAV account is missing its server URL or username — reconnect it in Settings.",
    );
  }
  return {
    accountId: ref.accountId,
    baseUrl: ref.baseUrl,
    username: ref.username,
    allowPrivateHost: ref.allowPrivateHost ?? false,
  };
}
