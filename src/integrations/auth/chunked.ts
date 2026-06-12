/**
 * Chunked keyring storage for large secrets.
 *
 * Windows Credential Manager caps a credential blob at 2560 bytes, and the
 * keyring backend stores secrets as UTF-16 — so anything beyond ~1280
 * characters fails to write. A Supabase session bundle (access JWT +
 * refresh token + user object) is typically 2–4 KB, which is exactly how
 * sign-in used to die: GoTrue returned 200, then persisting the session
 * rejected with a serialized CredentialError object that surfaced in the
 * UI as "[object Object]".
 *
 * Values that fit are stored verbatim (so existing small entries keep
 * working). Larger values split across `<account>.part<i>` slots with a
 * marker in the main slot recording the chunk count.
 *
 * Frontend-only: Rust never reads these services (`authRef` secrets stay
 * un-chunked), so the marker scheme can't confuse the Rust-side readers.
 */

import {
  deleteCredential,
  getCredential,
  setCredential,
} from "./credentials";

// 1024 UTF-16 code units = 2048 bytes — safely under the 2560-byte cap.
const CHUNK_CHARS = 1024;
const MARKER_PREFIX = "__typeward_chunks__:";

const partAccount = (account: string, i: number): string => `${account}.part${i}`;

/** Normalize Tauri IPC rejections (serialized error enums) into readable text. */
export function describeIpcError(e: unknown): string {
  if (e instanceof Error) return e.message;
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return String(e);
  }
}

function parseMarker(value: string): number | null {
  if (!value.startsWith(MARKER_PREFIX)) return null;
  const n = Number(value.slice(MARKER_PREFIX.length));
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function getChunkedCredential(
  service: string,
  account: string,
): Promise<string | null> {
  const main = await getCredential({ service, account });
  if (main === null) return null;
  const count = parseMarker(main);
  if (count === null) return main;
  const parts: string[] = [];
  for (let i = 0; i < count; i++) {
    const part = await getCredential({ service, account: partAccount(account, i) });
    // A missing part means a torn write — treat the whole value as absent
    // rather than handing back corrupted JSON.
    if (part === null) return null;
    parts.push(part);
  }
  return parts.join("");
}

export async function setChunkedCredential(
  service: string,
  account: string,
  value: string,
): Promise<void> {
  // Read the previous marker first so stale higher-index parts from a
  // longer old value get cleaned up.
  let previousCount = 0;
  try {
    const previous = await getCredential({ service, account });
    previousCount = previous === null ? 0 : (parseMarker(previous) ?? 0);
  } catch {
    // Unreadable old value — overwrite below regardless.
  }

  const inline = value.length <= CHUNK_CHARS && !value.startsWith(MARKER_PREFIX);
  const newCount = inline ? 0 : Math.ceil(value.length / CHUNK_CHARS);

  try {
    for (let i = 0; i < newCount; i++) {
      await setCredential(
        { service, account: partAccount(account, i) },
        value.slice(i * CHUNK_CHARS, (i + 1) * CHUNK_CHARS),
      );
    }
    await setCredential(
      { service, account },
      inline ? value : `${MARKER_PREFIX}${newCount}`,
    );
  } catch (e) {
    throw new Error(`Keyring write failed for ${service}/${account}: ${describeIpcError(e)}`);
  }

  // Drop stale parts left over from a previously longer (or now-inline) value.
  for (let i = newCount; i < previousCount; i++) {
    await deleteCredential({ service, account: partAccount(account, i) }).catch(() => {});
  }
}

export async function deleteChunkedCredential(
  service: string,
  account: string,
): Promise<void> {
  let count = 0;
  try {
    const main = await getCredential({ service, account });
    count = main === null ? 0 : (parseMarker(main) ?? 0);
  } catch {
    // Fall through — delete the main slot regardless.
  }
  await deleteCredential({ service, account });
  for (let i = 0; i < count; i++) {
    await deleteCredential({ service, account: partAccount(account, i) }).catch(() => {});
  }
}
