import { createSignal } from "solid-js";
import * as lspIpc from "~/lib/lsp/client";
import { initSession, pathToFileUri, type LspSession } from "~/lib/lsp/cm6";
import type { Project } from "~/adapters/types";

export type LspLanguage = "latex" | "typst";

interface SessionEntry {
  language: LspLanguage;
  projectRoot: string;
  session: LspSession;
}

const [sessions, setSessions] = createSignal<SessionEntry[]>([]);

// Concurrent startSession calls for the same language both pass the
// `findSession` check before either registers — track in-flight starts so
// the second caller awaits the first instead of spawning a second server.
const inFlight = new Map<LspLanguage, Promise<LspSession | null>>();

function findSession(language: LspLanguage): LspSession | null {
  return sessions().find((s) => s.language === language)?.session ?? null;
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
  const pending = inFlight.get(language);
  if (pending) return pending;
  const p = doStartSession(language, project, isCurrent).finally(() => {
    inFlight.delete(language);
  });
  inFlight.set(language, p);
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

export { findSession, sessions, startSession, stopAllSessions };
