/**
 * OneDrive / Microsoft Graph OAuth (PKCE) + token storage.
 *
 * App registration: portal.azure.com → App registrations → New →
 * "Accounts in any organizational directory and personal Microsoft
 * accounts". Add a public-client redirect URI for `http://localhost`
 * (Microsoft accepts any port when the host is localhost). Required
 * delegated permissions: `Files.ReadWrite`, `offline_access`,
 * `User.Read`.
 *
 * Client id is read from `VITE_MICROSOFT_CLIENT_ID` at build time.
 */

import { runOauthFlow } from "~/integrations/auth/oauth-client";
import {
  deleteCredential,
  getCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";

const AUTH_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/authorize";
const TOKEN_URL = "https://login.microsoftonline.com/common/oauth2/v2.0/token";
const KEYRING_SERVICE = "microsoft";
const SCOPES = ["Files.ReadWrite", "offline_access", "User.Read"];

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface MicrosoftAccount {
  accountId: string;
  email: string;
  displayName: string;
}

function clientId(): string {
  const id = import.meta.env.VITE_MICROSOFT_CLIENT_ID as string | undefined;
  if (!id) {
    throw new Error(
      "VITE_MICROSOFT_CLIENT_ID is not set — register an app at https://portal.azure.com/ → App registrations and add the application (client) id to .env.",
    );
  }
  return id;
}

export async function connectOneDrive(): Promise<MicrosoftAccount> {
  const tokens = await runOauthFlow({
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    clientId: clientId(),
    scopes: SCOPES,
  });

  const account = await fetchProfile(tokens.accessToken);
  await persistTokens(account.accountId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return account;
}

export async function disconnectOneDrive(accountId: string): Promise<void> {
  await deleteCredential({ service: KEYRING_SERVICE, account: accountId });
}

export async function getAccessToken(accountId: string): Promise<string> {
  const stored = await readTokens(accountId);
  if (!stored) {
    throw new Error("Microsoft account not connected");
  }
  if (!isExpiringSoon(stored.expiresAt)) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    throw new Error("Microsoft access token expired and no refresh token is available");
  }
  const refreshed = await refresh(stored.refreshToken);
  await persistTokens(accountId, refreshed);
  return refreshed.accessToken;
}

async function fetchProfile(accessToken: string): Promise<MicrosoftAccount> {
  const res = await httpRequest({
    method: "GET",
    url: "https://graph.microsoft.com/v1.0/me",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Microsoft profile fetch failed (status ${res.status})`);
  }
  const data = JSON.parse(res.body) as {
    id: string;
    userPrincipalName?: string;
    mail?: string;
    displayName?: string;
  };
  const email = data.mail ?? data.userPrincipalName ?? data.id;
  return {
    accountId: data.id,
    email,
    displayName: data.displayName ?? email,
  };
}

async function refresh(refreshToken: string): Promise<StoredTokens> {
  const body = new URLSearchParams({
    grant_type: "refresh_token",
    refresh_token: refreshToken,
    client_id: clientId(),
    scope: SCOPES.join(" "),
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
    throw new Error(`Microsoft token refresh failed (status ${res.status})`);
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
