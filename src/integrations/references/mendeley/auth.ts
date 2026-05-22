/**
 * Mendeley OAuth (PKCE) + token storage.
 *
 * Note on Mendeley's status (2026): Mendeley Desktop was discontinued in
 * September 2022 and the web product is in maintenance mode. The REST
 * API still works, but feature parity vs Zotero / JabRef will drift over
 * time. UI surfaces should warn users that JabRef / Zotero are better-
 * supported long-term — this provider exists for users migrating off
 * Mendeley, not for fresh adoption.
 *
 * The client id is read from `import.meta.env.VITE_MENDELEY_CLIENT_ID`
 * (registered at dev.mendeley.com — public, not secret). Without it,
 * `connectMendeley` throws with an actionable error.
 */

import { runOauthFlow } from "~/integrations/auth/oauth-client";
import {
  deleteCredential,
  getCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";

const AUTH_URL = "https://api.mendeley.com/oauth/authorize";
const TOKEN_URL = "https://api.mendeley.com/oauth/token";
const PROFILE_URL = "https://api.mendeley.com/profiles/me";
const KEYRING_SERVICE = "mendeley";
const SCOPES = ["all"];

interface StoredTokens {
  accessToken: string;
  refreshToken?: string;
  expiresAt?: number;
}

export interface MendeleyAccount {
  profileId: string;
  displayName: string;
  email?: string;
}

function clientId(): string {
  const id = import.meta.env.VITE_MENDELEY_CLIENT_ID as string | undefined;
  if (!id) {
    throw new Error(
      "VITE_MENDELEY_CLIENT_ID is not set — register a Mendeley OAuth app at https://dev.mendeley.com and add the client id to .env.",
    );
  }
  return id;
}

/**
 * Drive the full OAuth dance and return the authenticated account.
 * Persists the token bundle in the keyring under `mendeley` / profile id.
 */
export async function connectMendeley(): Promise<MendeleyAccount> {
  const tokens = await runOauthFlow({
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    clientId: clientId(),
    scopes: SCOPES,
  });

  const account = await fetchProfile(tokens.accessToken);
  await persistTokens(account.profileId, {
    accessToken: tokens.accessToken,
    refreshToken: tokens.refreshToken,
    expiresAt: tokens.expiresAt,
  });
  return account;
}

export async function disconnectMendeley(profileId: string): Promise<void> {
  await deleteCredential({ service: KEYRING_SERVICE, account: profileId });
}

/**
 * Returns a non-expired access token, refreshing once if needed. Throws
 * if no stored credentials exist for the account — caller should drive
 * a fresh `connectMendeley()`.
 */
export async function getAccessToken(profileId: string): Promise<string> {
  const stored = await readTokens(profileId);
  if (!stored) {
    throw new Error("Mendeley account not connected");
  }

  if (!isExpiringSoon(stored.expiresAt)) {
    return stored.accessToken;
  }

  if (!stored.refreshToken) {
    throw new Error("Mendeley access token expired and no refresh token is available");
  }

  const refreshed = await refresh(stored.refreshToken);
  await persistTokens(profileId, refreshed);
  return refreshed.accessToken;
}

async function fetchProfile(accessToken: string): Promise<MendeleyAccount> {
  const res = await httpRequest({
    method: "GET",
    url: PROFILE_URL,
    headers: {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/vnd.mendeley-profiles.1+json",
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`Mendeley profile fetch failed (status ${res.status})`);
  }
  const data = JSON.parse(res.body) as {
    id?: string;
    display_name?: string;
    email?: string;
  };
  if (!data.id) {
    throw new Error("Mendeley profile response is missing id");
  }
  return {
    profileId: data.id,
    displayName: data.display_name ?? data.id,
    email: data.email,
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
    throw new Error(`Mendeley token refresh failed (status ${res.status})`);
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

async function readTokens(profileId: string): Promise<StoredTokens | undefined> {
  const raw = await getCredential({ service: KEYRING_SERVICE, account: profileId });
  if (!raw) return undefined;
  try {
    return JSON.parse(raw) as StoredTokens;
  } catch {
    return undefined;
  }
}

async function persistTokens(profileId: string, tokens: StoredTokens): Promise<void> {
  await setCredential(
    { service: KEYRING_SERVICE, account: profileId },
    JSON.stringify(tokens),
  );
}

function isExpiringSoon(expiresAt: number | undefined): boolean {
  if (!expiresAt) return false;
  return expiresAt - 60 < Math.floor(Date.now() / 1000);
}
