/**
 * Cache directory layout for cloud-backed projects.
 *
 * Each cloud-backed project lives at:
 *   <projectsRoot>/.remote-cache/<providerId>/<projectId>/
 *
 * Inside that cache root, the project is a normal Typeward project — same
 * `.typeward/` sidecar, same file watcher, same compile pipeline. The
 * cloud sync engine only manages the cache contents; everything else
 * works because the cache *is* a project directory.
 *
 * Provider-specific state (cursor, id↔path map) lives under
 * `<cache>/.typeward/integrations/<providerId>/`.
 */

export const REMOTE_CACHE_DIR = ".remote-cache";

export function providerCacheRoot(projectsRoot: string, providerId: string): string {
  return joinPath(projectsRoot, REMOTE_CACHE_DIR, providerId);
}

export function projectCacheRoot(
  projectsRoot: string,
  providerId: string,
  projectId: string,
): string {
  return joinPath(providerCacheRoot(projectsRoot, providerId), projectId);
}

export function cursorPath(
  projectsRoot: string,
  providerId: string,
  projectId: string,
): string {
  return joinPath(
    projectCacheRoot(projectsRoot, providerId, projectId),
    ".typeward",
    "integrations",
    providerId,
    "cursor",
  );
}

export function idMapPath(
  projectsRoot: string,
  providerId: string,
  projectId: string,
): string {
  return joinPath(
    projectCacheRoot(projectsRoot, providerId, projectId),
    ".typeward",
    "integrations",
    providerId,
    "idmap.json",
  );
}

export function normalizeRemoteRelPath(relPath: string): string {
  const normalized = relPath.trim().replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.includes("\0") ||
    normalized.startsWith("/") ||
    normalized.startsWith("//") ||
    /^[a-z]:/i.test(normalized)
  ) {
    throw new Error(`Unsafe remote path '${relPath}'`);
  }

  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) {
    throw new Error(`Unsafe remote path '${relPath}'`);
  }
  if (segments[0] === ".typeward") {
    throw new Error(`Remote path '${relPath}' targets Typeward's internal state`);
  }
  return segments.join("/");
}

export function cachePathForRemoteRel(cacheRoot: string, relPath: string): string {
  return joinPath(cacheRoot, normalizeRemoteRelPath(relPath));
}

/**
 * Cross-platform path join — keeps the code paths working on both Win
 * (`\`) and unix. Strips redundant separators and leading slashes from
 * the right-hand segments so callers can pass relative paths without
 * worrying about an accidental absolute.
 */
function joinPath(...segments: string[]): string {
  if (segments.length === 0) return "";
  const sep = segments[0].includes("\\") ? "\\" : "/";
  const cleaned = segments
    .filter((s) => s != null && s !== "")
    .map((s, i) => (i === 0 ? s.replace(/[\\/]+$/, "") : s.replace(/^[\\/]+|[\\/]+$/g, "")));
  return cleaned.join(sep);
}
