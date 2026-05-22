/**
 * Dropbox OAuth (PKCE) + token storage.
 *
 * App registration: https://www.dropbox.com/developers/apps. Pick
 * "Scoped access" → "Full Dropbox" (or "App folder" if you'd rather
 * sandbox per-user under `/Apps/Typeward`). Required scopes:
 *   files.content.read  files.content.write
 *   files.metadata.read files.metadata.write
 *
 * Client id is read from `VITE_DROPBOX_CLIENT_ID` at build time. The
 * PKCE flow never needs the client secret.
 */

import { runOauthFlow } from "~/integrations/auth/oauth-client";
import {
  deleteCredential,
  getCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";

const AUTH_URL = "https://www.dropbox.com/oauth2/authorize";
const TOKEN_URL = "https://api.dropboxapi.com/oauth2/token";
const KEYRING_SERVICE = "dropbox";
const SCOPES = [
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

export async function getAccessToken(accountId: string): Promise<string> {
  const stored = await readTokens(accountId);
  if (!stored) {
    throw new Error("Dropbox account not connected");
  }
  if (!isExpiringSoon(stored.expiresAt)) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    throw new Error("Dropbox access token expired and no refresh token is available");
  }
  const refreshed = await refresh(stored.refreshToken);
  await persistTokens(accountId, refreshed);
  return refreshed.accessToken;
}

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

async function refresh(refreshToken: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
  }).toString();

  const res = await httpRequest({
    method: "POST",
    url: TOKEN_URL,
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
    },
    body,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Dropbox token refresh failed (status ${res.status})`);
  }
  const parsed = JSON.parse(res.body) as {
    access_token: string;
    refresh_token?: string;
    expires_in?: number;
  };
  return {
    accessToken: parsed.access_token,
    refreshToken: parsed.refresh_token ?? refreshToken,
    expiresAt: parsed.expires_in ? Math.floor(Date.now() / 1000) + parsed.expires_in : undefined,
  };
}

async function readTokens(accountId: string): Promise<StoredTokens | undefined> {
  const raw = await getCredential({ service: KEYRING_SERVICE, account: accountId });
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return undefined;
  }
}

async function persistTokens(accountId: string, tokens: StoredTokens): Promise<void> {
  await setCredential(
    { service: KEYRING_SERVICE, account: accountId },
    JSON.stringify(tokens),
  );
}

function isExpiringSoon(expiresAt: number | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt - 60 < Math.floor(Date.now() / 1000);
}
