import { createSignal } from "solid-js";
import * as lspIpc from "~/lib/lsp/client";
import { initSession, pathToFileUri, type LspSession } from "~/lib/lsp/cm6";
import type { Project } from "~/adapters/types";

export type LspLanguage = "latex" | "typst" | "markdown";

interface SessionEntry {
  language: LspLanguage;
  projectRoot: string;
  session: LspSession;
}

const [sessions, setSessions] = createSignal<SessionEntry[]>([]);

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

  let transport: lspIpc.LanguageServerClient;
  try {
    transport = await lspIpc.startLsp({
      languageId: language,
      projectRoot: project.rootPath,
    });
  } catch (e) {
    // Most common case: the LSP binary (texlab / tinymist / marksman) isn't
    // installed. Swallow — the editor still works, just without LSP features.
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
