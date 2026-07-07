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

export interface CredentialRef {
  service: string;
  account: string;
}

export interface OauthFlowOptions {
  /** Provider's authorization endpoint, e.g. `https://www.dropbox.com/oauth2/authorize`. */
  authUrl: string;
  /** Provider's token endpoint, e.g. `https://api.dropboxapi.com/oauth2/token`. */
  tokenUrl: string;
  clientId: string;
  scopes?: string[];
  /** Provider-specific extra params (e.g. `{ token_access_type: "offline" }`). */
  extraAuthParams?: Record<string, string>;
  /**
   * Exact registered loopback redirect URI for providers that exact-match it
   * (e.g. Mendeley) — must be `http://` on a loopback host with a port. Omit
   * for the default OS-assigned `127.0.0.1` port.
   */
  redirectUri?: string;
  /**
   * Client secret for confidential providers — the token exchange uses HTTP
   * Basic auth instead of PKCE. Only providers without PKCE support need this.
   */
  clientSecret?: string;
  /** Preferred confidential-client path: Rust reads the secret from keyring. */
  clientSecretRef?: CredentialRef;
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
      redirectUri: opts.redirectUri,
      clientSecret: opts.clientSecret,
      clientSecretRef: opts.clientSecretRef,
    },
  });

  // Diagnostic: the exact redirect_uri the provider sees must byte-match the
  // one registered for the app, or it rejects the request before redirecting.
  try {
    const sent = new URL(begin.url).searchParams.get("redirect_uri");
    console.info("[oauth] redirect_uri sent to provider:", sent);
  } catch {
    // begin.url is provider-built and always valid; ignore parse hiccups.
  }

  // `oauth_begin` has parked the loopback callback server; only a successful
  // `oauth_wait` (or its own timeout/error cleanup) tears it down. If we throw
  // before/at `oauth_wait` — opener failure, a rejected wait, caller abort — the
  // flow entry and its listener would otherwise leak until process exit (fatal
  // for Mendeley's fixed port). Release it explicitly on any non-success exit.
  let succeeded = false;
  try {
    await openUrl(begin.url);
    const tokens = await invoke<OauthTokens>("oauth_wait", { state: begin.state });
    succeeded = true;
    return tokens;
  } finally {
    if (!succeeded) {
      await invoke("oauth_cancel", { state: begin.state }).catch(() => {});
    }
  }
}
