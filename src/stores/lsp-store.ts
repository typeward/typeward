import { createSignal } from "solid-js";
import * as lspIpc from "~/lib/lsp/client";
import { initSession, pathToFileUri, type LspSession } from "~/lib/lsp/cm6";
import type { Project } from "~/adapters/types";
import type { LspLanguage } from "~/adapters/languages";

export type { LspLanguage };

interface SessionEntry {
  language: LspLanguage;
  projectRoot: string;
  session: LspSession;
}

const [sessions, setSessions] = createSignal<SessionEntry[]>([]);

// Concurrent startSession calls for the same language both pass the
// `findSession` check before either registers — track in-flight starts so
// the second caller awaits the first instead of spawning a second server.
// Keyed by language + project root: a pending start from a switched-away
// project self-cancels via its stale isCurrent and resolves null, so handing
// it to the new project's start would leave that project without LSP.
// Cleared on stopAllSessions so a same-key reopen (A -> B -> A) issues a
// fresh start instead of adopting the abandoned one.
const inFlight = new Map<string, Promise<LspSession | null>>();

const startKey = (language: LspLanguage, rootPath: string): string =>
  `${language}::${rootPath}`;

function findSession(language: LspLanguage): LspSession | null {
  return sessions().find((s) => s.language === language)?.session ?? null;
}

/**
 * The active session's server-advertised capabilities (initialize result),
 * or null when no session is up or the server sent none. The gate for every
 * capability-dependent feature: incremental didChange, rename, references...
 */
function serverCapabilities(language: LspLanguage): Record<string, unknown> | null {
  return findSession(language)?.serverCapabilities ?? null;
}

/**
 * Start an LSP session for `language` rooted at `project.rootPath`. Returns
 * null silently if the server binary isn't installed — callers should treat
 * this as "LSP not available for this file" rather than an error.
 */
async function startSession(
  language: LspLanguage,
  project: Project,
  isCurrent: () => boolean = () => true,
): Promise<LspSession | null> {
  // Avoid duplicate sessions per language.
  const existing = findSession(language);
  if (existing) return existing;
  const key = startKey(language, project.rootPath);
  const pending = inFlight.get(key);
  if (pending) {
    const adopted = await pending;
    if (adopted) return adopted;
    if (!isCurrent()) return null;
    // The adopted start belonged to a since-abandoned open of the same
    // project (A -> B -> A without teardown getting there first) and
    // self-cancelled to null. This caller is still current, so fall through
    // to a fresh start instead of surfacing the stale null — but re-check
    // both registries first: another caller may have registered or reissued
    // while we awaited.
    const registered = findSession(language);
    if (registered) return registered;
    const reissued = inFlight.get(key);
    if (reissued) return reissued;
  }
  const p = doStartSession(language, project, isCurrent).finally(() => {
    // Identity-guarded: after teardown clears the map and a reopen issues a
    // fresh start under the same key, the stale start's cleanup must not
    // evict the fresh pending entry.
    if (inFlight.get(key) === p) inFlight.delete(key);
  });
  inFlight.set(key, p);
  return p;
}

async function doStartSession(
  language: LspLanguage,
  project: Project,
  isCurrent: () => boolean,
): Promise<LspSession | null> {

  let transport: lspIpc.LanguageServerClient;
  try {
    transport = await lspIpc.startLsp({
      languageId: language,
      projectRoot: project.rootPath,
    });
  } catch (e) {
    // Most common case: the LSP binary (texlab / tinymist) isn't installed.
    // Swallow — the editor still works, just without LSP features.
    console.warn(`LSP unavailable for ${language}:`, e);
    return null;
  }
  if (!isCurrent()) {
    await transport.stop().catch(() => {
      /* stale startup; server may already be gone */
    });
    return null;
  }

  const client = lspIpc.wrap(transport);
  try {
    const session = await initSession(client, pathToFileUri(project.rootPath));
    if (!isCurrent()) {
      await session.stop().catch(() => {
        /* stale startup; server may already be gone */
      });
      return null;
    }
    setSessions((prev) => [
      ...prev,
      { language, projectRoot: project.rootPath, session },
    ]);
    // Evict the session when its server dies (crash / reader EOF). wrap()
    // already rejects in-flight requests on close; without this the dead entry
    // lingers in the registry for the project's lifetime, so findSession keeps
    // handing out a zombie and no fresh server is ever started. After eviction
    // the next open of a matching file spawns a new server.
    transport.onClose(() => {
      setSessions((prev) => prev.filter((e) => e.session !== session));
    });
    return session;
  } catch (e) {
    console.warn(`LSP initialize failed for ${language}:`, e);
    await client.stop();
    return null;
  }
}

/**
 * Stop every running session — call when the project is closed or the app
 * unmounts. Errors are swallowed (the server might already be dead).
 */
async function stopAllSessions(): Promise<void> {
  // Pending starts belong to the project being closed — drop them (before the
  // empty-sessions early return: a start can be in flight with nothing
  // registered yet) so a same-key reopen issues a fresh start instead of
  // adopting a promise that self-cancels to null via its stale isCurrent.
  inFlight.clear();
  const current = sessions();
  // No-op when already empty. EditorScreen calls this synchronously from a
  // createEffect; without this guard, setSessions([]) writes a fresh array
  // reference on every call, re-triggering the effect that reads sessions() in
  // an infinite loop (e.g. when the editor route mounts with no project).
  if (current.length === 0) return;
  setSessions([]);
  await Promise.all(
    current.map((s) =>
      s.session.stop().catch(() => {
        /* server already gone; ignore */
      }),
    ),
  );
}

export { findSession, serverCapabilities, sessions, startSession, stopAllSessions };
