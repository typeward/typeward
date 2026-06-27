/**
 * OS keyring wrapper. Tokens and API keys live here, never in settings.json.
 *
 * Naming convention: `service` is the provider id without prefix (the Rust
 * side scopes it to `typeward.<service>`). `account` is whatever uniquely
 * identifies the slot within that provider — typically the user's email or
 * the provider-specific user id.
 */

import { invoke } from "@tauri-apps/api/core";

export interface CredentialRef {
  service: string;
  account: string;
}

export const setCredential = (ref: CredentialRef, secret: string): Promise<void> =>
  invoke("credential_set", { service: ref.service, account: ref.account, secret });

export const getCredential = (ref: CredentialRef): Promise<string | null> =>
  invoke<string | null>("credential_get", {
    service: ref.service,
    account: ref.account,
  });

export const credentialExists = (ref: CredentialRef): Promise<boolean> =>
  invoke<boolean>("credential_exists", {
    service: ref.service,
    account: ref.account,
  });

export const deleteCredential = (ref: CredentialRef): Promise<void> =>
  invoke("credential_delete", { service: ref.service, account: ref.account });

/**
 * Dedicated read for the Supabase session bundle. supabase-js needs the
 * session value in the webview, so it is read through this purpose-specific
 * command rather than the generic, allowlist-locked `credential_get`. Rust
 * reassembles the chunked value that `setChunkedCredential` wrote.
 */
export const readSupabaseSession = (account: string): Promise<string | null> =>
  invoke<string | null>("supabase_session_read", { account });
