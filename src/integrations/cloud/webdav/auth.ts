/**
 * WebDAV account enrollment.
 *
 * Unlike the OAuth providers, WebDAV auth is a plain form: server URL +
 * username + (app) password. The password is stored in the OS keyring under
 * service `webdav` / account id; Rust reads it there to build the Basic auth
 * header — it never travels on a `webdav_*` IPC call after enrollment.
 *
 * The host is screened for SSRF at save time (`webdav_validate_host`) before
 * the credential is stored, and a `PROPFIND Depth:0` probe verifies the
 * credentials before the account is considered connected.
 */

import { deleteCredential, setCredential } from "~/integrations/auth/credentials";

import { type WebdavAccount, webdavStatusProbe, webdavValidateHost } from "./ipc";

const KEYRING_SERVICE = "webdav";

export interface WebdavConnectInput {
  /** Raw server URL the user pasted (already normalized by the dialog). */
  url: string;
  username: string;
  password: string;
  allowPrivateHost: boolean;
}

export interface WebdavConnected extends WebdavAccount {
  /** Display label, e.g. `me@cloud.example.com`. */
  label: string;
  host: string;
}

/** Keyring account id; must be stable and free of `/` (the keyring rejects it). */
export function webdavAccountId(host: string, username: string): string {
  return `${username}@${host}`.replace(/[^A-Za-z0-9._@-]/g, "_");
}

export async function connectWebdav(input: WebdavConnectInput): Promise<WebdavConnected> {
  const verdict = await webdavValidateHost(input.url, input.allowPrivateHost);
  if (!verdict.ok) {
    throw new Error(verdict.reason ?? "WebDAV server is not reachable or not allowed.");
  }

  const accountId = webdavAccountId(verdict.host, input.username);
  await setCredential({ service: KEYRING_SERVICE, account: accountId }, input.password);

  const account: WebdavAccount = {
    accountId,
    baseUrl: verdict.baseUrl,
    username: input.username,
    allowPrivateHost: input.allowPrivateHost,
  };

  let reachable = false;
  try {
    reachable = await webdavStatusProbe(account);
  } catch (err) {
    await deleteCredential({ service: KEYRING_SERVICE, account: accountId });
    throw err;
  }
  if (!reachable) {
    await deleteCredential({ service: KEYRING_SERVICE, account: accountId });
    throw new Error("WebDAV sign-in failed — check the username and app password.");
  }

  return {
    ...account,
    label: `${input.username}@${verdict.host}`,
    host: verdict.host,
  };
}

export async function disconnectWebdav(accountId: string): Promise<void> {
  await deleteCredential({ service: KEYRING_SERVICE, account: accountId });
}
