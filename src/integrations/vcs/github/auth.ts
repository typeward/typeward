/**
 * GitHub OAuth via device flow.
 *
 * Device flow (RFC 8628) is the right choice for desktop + tablet:
 *   - no loopback callback server (works on iPadOS / Android without
 *     deep links)
 *   - one client id, no client secret needed
 *   - same UX as `gh auth login` so users recognize the dance
 *
 * App registration: github.com/settings/applications/new (or organization
 * settings) → "OAuth Apps" → enable "Device flow" in the new dialog.
 * Required scope: `repo` (full repo access for private + public).
 * Client id from `VITE_GITHUB_CLIENT_ID`.
 *
 * The resulting token is stored in the OS keyring under service
 * `git.github.com` / account `x-access-token` so it sits exactly where
 * libgit2's HTTPS callbacks look on push / pull / clone. No second
 * credential store.
 */

import { openUrl } from "@tauri-apps/plugin-opener";

import {
  credentialExists,
  deleteCredential,
  setCredential,
} from "~/integrations/auth/credentials";
import { httpRequest } from "~/integrations/http";

const DEVICE_CODE_URL = "https://github.com/login/device/code";
const TOKEN_URL = "https://github.com/login/oauth/access_token";
const USERINFO_URL = "https://api.github.com/user";
const KEYRING_SERVICE = "git.github.com";
const KEYRING_ACCOUNT = "x-access-token";
const PROFILE_KEYRING_SERVICE = "github-profile";
const SCOPE = "repo";

export interface GitHubAccount {
  login: string;
  /** Display name from the GitHub profile, when set. Falls back to `login`. */
  displayName: string;
  /** Public email when set, else null. */
  email: string | null;
}

interface DeviceCodeResponse {
  device_code: string;
  user_code: string;
  verification_uri: string;
  expires_in: number;
  interval: number;
}

interface DeviceTokenPending {
  error: "authorization_pending" | "slow_down";
  interval?: number;
}

interface DeviceTokenSuccess {
  access_token: string;
  token_type: string;
  scope: string;
}

interface DeviceTokenError {
  error: "expired_token" | "access_denied" | "unsupported_grant_type" | string;
  error_description?: string;
}

function clientId(): string {
  const id = import.meta.env.VITE_GITHUB_CLIENT_ID as string | undefined;
  if (!id) {
    throw new Error(
      "VITE_GITHUB_CLIENT_ID is not set — register a GitHub OAuth App (with Device Flow enabled) and add the client id to .env.",
    );
  }
  return id;
}

/**
 * Drive the full device flow end-to-end. Polls GitHub at the
 * server-provided cadence; opens the verification URL in the user's
 * default browser pre-filled with the user code so they only need to
 * click "Authorize".
 *
 * Returns the authenticated account once complete.
 */
export async function connectGithub(
  onUserCode?: (code: string, verificationUri: string) => void,
): Promise<GitHubAccount> {
  const begin = await beginDeviceFlow();

  // Surface the user code to the UI right away. The dialog displays it
  // big + monospace so the user can read it off-screen if needed.
  onUserCode?.(begin.user_code, begin.verification_uri);

  // GitHub also exposes `verification_uri_complete` on some flows; the
  // public one (`verification_uri`) is universally available.
  await openUrl(`${begin.verification_uri}?user_code=${encodeURIComponent(begin.user_code)}`);

  const token = await pollDeviceFlow(begin);

  // Store the token where libgit2's HTTPS callbacks will look for it.
  await setCredential(
    { service: KEYRING_SERVICE, account: KEYRING_ACCOUNT },
    token.access_token,
  );

  const account = await fetchAccount();
  // Cache the lightweight profile alongside the token so the settings
  // surface and clone picker can show "Connected as <login>" without
  // another /user call on every render.
  await setCredential(
    { service: PROFILE_KEYRING_SERVICE, account: account.login },
    JSON.stringify(account),
  );
  return account;
}

export async function disconnectGithub(login: string): Promise<void> {
  await deleteCredential({ service: KEYRING_SERVICE, account: KEYRING_ACCOUNT });
  await deleteCredential({ service: PROFILE_KEYRING_SERVICE, account: login });
}

/**
 * Whether a GitHub token is currently available in the keyring. Useful
 * for gating UI without forcing a network round trip.
 */
export async function hasGithubCredential(): Promise<boolean> {
  return credentialExists({
    service: KEYRING_SERVICE,
    account: KEYRING_ACCOUNT,
  });
}

async function beginDeviceFlow(): Promise<DeviceCodeResponse> {
  const body = new URLSearchParams({ client_id: clientId(), scope: SCOPE }).toString();
  const res = await httpRequest({
    method: "POST",
    url: DEVICE_CODE_URL,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub device-code request failed (status ${res.status}): ${res.body}`);
  }
  return JSON.parse(res.body) as DeviceCodeResponse;
}

async function pollDeviceFlow(begin: DeviceCodeResponse): Promise<DeviceTokenSuccess> {
  const deadline = Date.now() + begin.expires_in * 1000;
  let intervalMs = Math.max(begin.interval, 5) * 1000;

  while (Date.now() < deadline) {
    await sleep(intervalMs);

    const body = new URLSearchParams({
      client_id: clientId(),
      device_code: begin.device_code,
      grant_type: "urn:ietf:params:oauth:grant-type:device_code",
    }).toString();

    const res = await httpRequest({
      method: "POST",
      url: TOKEN_URL,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body,
    });

    if (res.status < 200 || res.status >= 300) {
      throw new Error(`GitHub token poll failed (status ${res.status}): ${res.body}`);
    }

    const parsed = JSON.parse(res.body) as
      | DeviceTokenSuccess
      | DeviceTokenPending
      | DeviceTokenError;

    if ("access_token" in parsed) {
      return parsed;
    }
    if ("error" in parsed && (parsed.error === "authorization_pending" || parsed.error === "slow_down")) {
      if (parsed.error === "slow_down") {
        // GitHub asks us to back off; bump the interval by 5s as the
        // spec recommends.
        intervalMs += 5_000;
      }
      continue;
    }
    if ("error" in parsed) {
      const description =
        "error_description" in parsed ? parsed.error_description : undefined;
      throw new Error(
        `GitHub authorization failed (${parsed.error}): ${description ?? "no description"}`,
      );
    }
  }

  throw new Error("GitHub device code expired before authorization completed.");
}

async function fetchAccount(): Promise<GitHubAccount> {
  const res = await httpRequest({
    method: "GET",
    url: USERINFO_URL,
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
    },
    authRef: {
      service: KEYRING_SERVICE,
      account: KEYRING_ACCOUNT,
      header: "Authorization",
      prefix: "Bearer ",
    },
  });
  if (res.status < 200 || res.status >= 300) {
    throw new Error(`GitHub /user fetch failed (status ${res.status}): ${res.body}`);
  }
  const data = JSON.parse(res.body) as {
    login: string;
    name?: string | null;
    email?: string | null;
  };
  return {
    login: data.login,
    displayName: data.name ?? data.login,
    email: data.email ?? null,
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
