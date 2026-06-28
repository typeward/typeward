/**
 * Dropbox OAuth (PKCE) + token storage.
 *
 * App registration: https://www.dropbox.com/developers/apps. Pick
 * "Scoped access" → "Full Dropbox" (or "App folder" if you'd rather
 * sandbox per-user under `/Apps/Typeward`). These must be enabled in the
 * app's Permissions tab (a new scoped app has none — without them the
 * authorize step fails with "No scope requested can be granted for this app"):
 *   account_info.read    (get_current_account, called right after auth)
 *   files.content.read   files.content.write
 *   files.metadata.read  files.metadata.write
 *
 * Also add `http://localhost:48121/callback` exactly (including the path) under
 * Settings -> "OAuth 2 -> Redirect URIs", or the authorize step fails with
 * "Invalid redirect_uri".
 *
 * Client id is read from `VITE_DROPBOX_CLIENT_ID` at build time. The
 * PKCE flow never needs the client secret.
 */

import { runOauthFlow } from "~/integrations/auth/oauth-client";
import {
  credentialExists,
  deleteCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest, type HttpAuthRef } from "~/integrations/http";

const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const KEYRING_SERVICE = "dropbox";
// Dropbox requires redirect_uri to EXACTLY match a pre-registered URI and does
// not allow the dynamic loopback port that other PKCE providers accept, so we
// pin a fixed loopback URL. Register this EXACT value (including the path) under
// the app's Settings -> "OAuth 2 -> Redirect URIs" in the Dropbox App Console.
const REDIRECT_URI = "http://localhost:48121/callback";
const SCOPES = [
  // get_current_account (fetchAccount, run immediately after the token
  // exchange) needs this — without it the post-auth profile call 401s.
  "account_info.read",
  "files.content.read",
  "files.content.write",
  "files.metadata.read",
  "files.metadata.write",
];

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface DropboxAccount {
  accountId: string;
  email: string;
  displayName: string;
}

function clientId(): string {
  const id = import.meta.env.VITE_DROPBOX_CLIENT_ID as string | undefined;
  if (!id) {
    throw new Error(
      "VITE_DROPBOX_CLIENT_ID is not set — register a Dropbox app at https://www.dropbox.com/developers/apps and add the app key to .env.",
    );
  }
  return id;
}

export async function connectDropbox(): Promise<DropboxAccount> {
  const tokens = await runOauthFlow({
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    clientId: clientId(),
    scopes: SCOPES,
    // Fixed loopback URI (must match the Dropbox app registration exactly) —
    // Dropbox rejects the dynamic-port default with "Invalid redirect_uri".
    redirectUri: REDIRECT_URI,
    // `token_access_type=offline` is required to receive a refresh token.
    extraAuthParams: { token_access_type: "offline" },
  });

  const account = await fetchAccount(tokens.accessToken);
  await persistTokens(account.accountId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return account;
}

export async function disconnectDropbox(accountId: string): Promise<void> {
  await deleteCredential({ service: KEYRING_SERVICE, account: accountId });
}

export function dropboxAuthRef(accountId: string): HttpAuthRef {
  return {
    service: KEYRING_SERVICE,
    account: accountId,
    header: "Authorization",
    prefix: "Bearer ",
    clientId: clientId(),
  };
}

export const hasDropboxTokens = (accountId: string): Promise<boolean> =>
  credentialExists({ service: KEYRING_SERVICE, account: accountId });

async function fetchAccount(accessToken: string): Promise<DropboxAccount> {
  // `/2/users/get_current_account` returns the signed-in user's profile.
  const res = await httpRequest({
    method: "POST",
    url: "https://api.dropboxapi.com/2/users/get_current_account",
    headers: {
      Authorization: `Bearer ${accessToken}`,
      "Content-Type": "application/json",
    },
    body: "null",
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Dropbox account fetch failed (status ${res.status}): ${res.body}`);
  }
  const data = JSON.parse(res.body) as {
    account_id: string;
    email: string;
    name?: { display_name?: string };
  };
  return {
    accountId: data.account_id,
    email: data.email,
    displayName: data.name?.display_name ?? data.email,
  };
}

async function persistTokens(accountId: string, tokens: StoredTokens): Promise<void> {
  await setCredential(
    { service: KEYRING_SERVICE, account: accountId },
    JSON.stringify(tokens),
  );
}
