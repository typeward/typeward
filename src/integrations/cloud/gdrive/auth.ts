/**
 * Google Drive OAuth (PKCE) + token storage.
 *
 * App registration: console.cloud.google.com → APIs & Services → OAuth
 * client → "Desktop app" type (so Google accepts loopback redirects).
 * Required scope: `https://www.googleapis.com/auth/drive.file` (per-app
 * scope — only files created/opened by Typeward are visible). Broader
 * `drive` scope is possible later if a deep "browse my existing Drive"
 * UX is needed, but it requires Google verification + privacy review.
 *
 * Client id is read from `VITE_GOOGLE_CLIENT_ID` at build time.
 */

import { runOauthFlow } from "~/integrations/auth/oauth-client";
import {
  deleteCredential,
  getCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";

const AUTH_URL = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL = "https://oauth2.googleapis.com/token";
const KEYRING_SERVICE = "google";
const SCOPES = [
  "https://www.googleapis.com/auth/drive.file",
  "https://www.googleapis.com/auth/userinfo.email",
];

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface GoogleAccount {
  accountId: string;
  email: string;
  displayName: string;
}

function clientId(): string {
  const id = import.meta.env.VITE_GOOGLE_CLIENT_ID as string | undefined;
  if (!id) {
    throw new Error(
      "VITE_GOOGLE_CLIENT_ID is not set — register a Desktop OAuth client at https://console.cloud.google.com/ → APIs & Services and add the client id to .env.",
    );
  }
  return id;
}

export async function connectGoogleDrive(): Promise<GoogleAccount> {
  const tokens = await runOauthFlow({
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    clientId: clientId(),
    scopes: SCOPES,
    extraAuthParams: {
      // `offline` to get a refresh token; `consent` forces the prompt
      // so we get a fresh refresh_token on every connect.
      access_type: "offline",
      prompt: "consent",
    },
  });

  const account = await fetchAccount(tokens.accessToken);
  await persistTokens(account.accountId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return account;
}

export async function disconnectGoogleDrive(accountId: string): Promise<void> {
  await deleteCredential({ service: KEYRING_SERVICE, account: accountId });
}

export async function getAccessToken(accountId: string): Promise<string> {
  const stored = await readTokens(accountId);
  if (!stored) {
    throw new Error("Google account not connected");
  }
  if (!isExpiringSoon(stored.expiresAt)) {
    return stored.accessToken;
  }
  if (!stored.refreshToken) {
    throw new Error("Google access token expired and no refresh token is available");
  }
  const refreshed = await refresh(stored.refreshToken);
  await persistTokens(accountId, refreshed);
  return refreshed.accessToken;
}

async function fetchAccount(accessToken: string): Promise<GoogleAccount> {
  const res = await httpRequest({
    method: "GET",
    url: "https://www.googleapis.com/oauth2/v3/userinfo",
    headers: { Authorization: `Bearer ${accessToken}`, Accept: "application/json" },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Google profile fetch failed (status ${res.status})`);
  }
  const data = JSON.parse(res.body) as {
    sub: string;
    email?: string;
    name?: string;
  };
  return {
    accountId: data.sub,
    email: data.email ?? data.sub,
    displayName: data.name ?? data.email ?? data.sub,
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
    throw new Error(`Google token refresh failed (status ${res.status})`);
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
