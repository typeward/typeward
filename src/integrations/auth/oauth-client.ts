/**
 * High-level OAuth 2.0 PKCE driver.
 *
 * Composes the Rust IPC `oauth_begin` / `oauth_wait` with the opener plugin
 * so callers get a single async API:
 *
 *   const tokens = await runOauthFlow({ authUrl, tokenUrl, clientId, scopes });
 *
 * Token persistence is intentionally NOT done here — once a flow returns
 * tokens, the calling provider decides how to identify the account
 * (typically via a follow-up `/userinfo` call) and writes to the keyring
 * under its own naming scheme. Keeping the OAuth layer free of identity
 * assumptions makes it reusable across providers with very different
 * userinfo conventions (Supabase, Google, GitHub, Dropbox, etc).
 */

import { invoke } from "@tauri-apps/api/core";
import { openUrl } from "@tauri-apps/plugin-opener";

export interface OauthFlowOptions {
  /** Provider's authorization endpoint, e.g. `https://accounts.google.com/o/oauth2/v2/auth`. */
  authUrl: string;
  /** Provider's token endpoint, e.g. `https://oauth2.googleapis.com/token`. */
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  /** Provider-specific extra params (e.g. `{ access_type: "offline" }`). */
  extraAuthParams?: Record<string, string>;
}

export interface OauthTokens {
  accessToken: string;
  refreshToken?: string;
  /** Unix-epoch seconds; absent for providers that don't surface expiry. */
  expiresAt?: number;
  tokenType: string;
  scope?: string;
}

interface BeginResponse {
  url: string;
  state: string;
}

/**
 * Run a single PKCE OAuth flow end-to-end. Spawns a loopback callback
 * server in Rust, opens the auth URL in the user's default browser,
 * blocks on the callback, exchanges the code, and resolves to the
 * provider's tokens. Rejects on timeout (5 minutes) or any provider
 * error.
 */
export async function runOauthFlow(opts: OauthFlowOptions): Promise<OauthTokens> {
  const begin = await invoke<BeginResponse>("oauth_begin", {
    req: {
      authUrl: opts.authUrl,
      tokenUrl: opts.tokenUrl,
      clientId: opts.clientId,
      scopes: opts.scopes ?? [],
      extraAuthParams: opts.extraAuthParams ?? {},
    },
  });

  await openUrl(begin.url);

  return invoke<OauthTokens>("oauth_wait", { state: begin.state });
}
