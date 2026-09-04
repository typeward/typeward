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
  createWebdavProvider,
  type WebdavAccount,
} from "~/integrations/cloud/webdav";
import type { CloudFsProvider } from "~/integrations/types";

export type CloudProviderId = "webdav";

/**
 * Registry idiom (cloud): unlike references (open reactive list) and AI
 * (single-active union + lazy map), cloud has no long-lived registry — this is
 * a per-account factory with an exhaustive `switch`, because a provider is
 * instantiated on demand per active project.
 *
 * NOTE: `baseUrl`/`username`/`allowPrivateHost` stay optional even though WebDAV
 * is now the only provider — they mirror `IntegrationsSettings.cloud.accounts`,
 * where they are optional on both the TS and the Rust side, so a settings.json
 * written by an older build (or edited by hand) can still yield an account
 * without them. `asWebdav` is where that becomes an actionable error instead of
 * a malformed request.
 */
export interface CloudAccountRef {
  provider: CloudProviderId;
  accountId: string;
  /** Cached display label (email or "Display Name"). */
  label?: string;
  // The server URL + username needed to rebuild the provider (the password is
  // in the keyring).
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
    case "webdav":
      return createWebdavProvider(asWebdav(ref));
    default: {
      const _exhaust: never = ref.provider;
      throw new Error(`Unknown cloud provider id '${_exhaust as string}'`);
    }
  }
}

/**
 * Pull the cloud account ref off the project's persisted integrations
 * block, if any. The project carries provider + remote rootId; the
 * account credentials live in the user's IntegrationsSettings.
 *
 * A project bound to a provider this build no longer ships (a pre-existing
 * Dropbox binding) reads as "not cloud-backed": the cache directory is a normal
 * Typeward project, so it keeps opening and compiling — it just stops syncing.
 */
export function readCloudOrigin(project: Project): {
  provider: CloudProviderId;
  accountId: string;
  remotePath: string;
} | null {
  const origin = project.integrations?.cloudOrigin;
  if (!origin) return null;
  if (origin.provider !== "webdav") return null;
  return {
    provider: origin.provider,
    accountId: origin.accountId,
    remotePath: origin.remotePath,
  };
}

// Coerce the lightweight CloudAccountRef into the provider's richer account
// type. WebDAV needs the server URL + username (the password is in the
// keyring). The settings account ref carries them; if a pre-existing ref lost
// them the user must reconnect.

function asWebdav(ref: CloudAccountRef): WebdavAccount {
  if (!ref.baseUrl || !ref.username) {
    throw new Error(
      "WebDAV account is missing its server URL or username. Reconnect it in Settings.",
    );
  }
  return {
    accountId: ref.accountId,
    baseUrl: ref.baseUrl,
    username: ref.username,
    allowPrivateHost: ref.allowPrivateHost ?? false,
  };
}
