/**
 * Mendeley OAuth (confidential authorization-code) + token storage.
 *
 * Note on Mendeley's status (2026): Mendeley Desktop was discontinued in
 * September 2022 and the web product is in maintenance mode. The REST
 * API still works, but feature parity vs Zotero will drift over time. UI
 * surfaces should warn users that Zotero is the better-supported choice
 * long-term — this provider exists for users migrating off Mendeley, not
 * for fresh adoption.
 *
 * Unlike PKCE providers, Mendeley is a *confidential* OAuth client: it does
 * not support PKCE and authenticates the token exchange with HTTP Basic
 * (client_id:client_secret). It also exact-matches the redirect URI with no
 * dynamic ports, so the user registers one redirect URL in their Mendeley app
 * and the flow uses it verbatim (a loopback http URL with a port; default
 * `http://localhost:5000/callback`). The loopback server binds both IPv4 and
 * IPv6 so `localhost` resolves either way.
 *
 * The client id is read from `import.meta.env.VITE_MENDELEY_CLIENT_ID`
 * (public, not secret). The client *secret* is entered in Settings and stored
 * in the OS keyring (service `mendeley`, account `app-secret`). Without either,
 * `connectMendeley` throws with an actionable error.
 */

import { runOauthFlow } from "~/integrations/auth/oauth-client";
import {
  credentialExists,
  deleteCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest, type HttpAuthRef } from "~/integrations/http";

const AUTH_URL = "https://api.mendeley.com/oauth/authorize";
const TOKEN_URL = "https://api.mendeley.com/oauth/token";
const PROFILE_URL = "https://api.mendeley.com/profiles/me";
const KEYRING_SERVICE = "mendeley";
// Keyring account for the app's client secret. Distinct from token bundles,
// which key on the Mendeley profile id (a UUID, never this literal).
const SECRET_ACCOUNT = "app-secret";
// Used when the user hasn't configured a redirect URL; must match whatever is
// registered in their Mendeley app.
const DEFAULT_REDIRECT_URI = "http://localhost:5000/callback";
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
      "VITE_MENDELEY_CLIENT_ID is not set. Register a Mendeley OAuth app at https://dev.mendeley.com and add the client id to .env.",
    );
  }
  return id;
}

async function assertClientSecretConfigured(): Promise<void> {
  if (!(await hasMendeleyClientSecret())) {
    throw new Error(
      "Mendeley client secret is not set. Paste it in Settings → Integrations → References (Mendeley) first.",
    );
  }
}

/** Persist the app's Mendeley client secret to the OS keyring. */
export async function setMendeleyClientSecret(secret: string): Promise<void> {
  await setCredential({ service: KEYRING_SERVICE, account: SECRET_ACCOUNT }, secret);
}

/** Whether a client secret has been stored (without reading it back). */
export async function hasMendeleyClientSecret(): Promise<boolean> {
  return credentialExists({ service: KEYRING_SERVICE, account: SECRET_ACCOUNT });
}

/**
 * Drive the full OAuth dance and return the authenticated account.
 * Persists the token bundle in the keyring under `mendeley` / profile id.
 */
export async function connectMendeley(redirectUri?: string): Promise<MendeleyAccount> {
  await assertClientSecretConfigured();
  const tokens = await runOauthFlow({
    authUrl: AUTH_URL,
    tokenUrl: TOKEN_URL,
    clientId: clientId(),
    scopes: SCOPES,
    clientSecretRef: { service: KEYRING_SERVICE, account: SECRET_ACCOUNT },
    redirectUri: redirectUri?.trim() || DEFAULT_REDIRECT_URI,
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

export function mendeleyAuthRef(profileId: string): HttpAuthRef {
  return {
    service: KEYRING_SERVICE,
    account: profileId,
    header: "Authorization",
    prefix: "Bearer ",
    clientId: clientId(),
  };
}

export const hasMendeleyTokens = (profileId: string): Promise<boolean> =>
  credentialExists({ service: KEYRING_SERVICE, account: profileId });

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

async function persistTokens(profileId: string, tokens: StoredTokens): Promise<void> {
  await setCredential(
    { service: KEYRING_SERVICE, account: profileId },
    JSON.stringify(tokens),
  );
}
