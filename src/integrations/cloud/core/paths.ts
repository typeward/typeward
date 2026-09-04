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
 * `<cache>/.typeward/integrations/<providerStateSegment(providerId)>/`.
 */

/**
 * A remote-relative path that has passed `normalizeRemoteRelPath` — the single
 * producer. Branding it makes the funnel visible to the compiler: engine data
 * structures that key on remote paths (the sync-state manifest, the pending
 * push set, the echo-suppression map) require this type, so a raw provider
 * string (a WebDAV href) cannot be inserted without first passing the
 * traversal / `.typeward` / absolute-path rejection. Runtime value is a plain
 * string; the brand exists only at compile time.
 */
export type NormalizedRelPath = string & { readonly __normalizedRemoteRelPath: unique symbol };

export const REMOTE_CACHE_DIR = ".remote-cache";

/**
 * A provider id is an identifier, not a filename: the WebDAV one is
 * `webdav:<username>@<host>`, and Windows rejects a path component containing
 * `< > : " / \ | ? *`, a control character, or a trailing dot or space
 * (os error 123). Spelling one into a directory name made every WebDAV project
 * fail to open there, at the first cursor write.
 *
 * Percent-encode the offending characters rather than stripping or replacing
 * them, so the mapping stays reversible and two account ids can never collapse
 * onto one state directory (which would silently merge their sync baselines).
 * `%` is in the escaped set and is substituted in the same pass, so an id that
 * already contains a percent sign round-trips too.
 */
export function providerStateSegment(providerId: string): string {
  const escape = (c: string) =>
    `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}`;
  return providerId
    .replace(/[%<>:"/\\|?*\u0000-\u001f]/g, escape)
    .replace(/[. ]$/, escape);
}

export function providerCacheRoot(projectsRoot: string, providerId: string): string {
  return joinPath(projectsRoot, REMOTE_CACHE_DIR, providerStateSegment(providerId));
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
  return providerStatePath(
    projectCacheRoot(projectsRoot, providerId, projectId),
    providerId,
    "cursor",
  );
}

export function cursorPathForCacheRoot(cacheRoot: string, providerId: string): string {
  return providerStatePath(cacheRoot, providerId, "cursor");
}

export function idMapPath(
  projectsRoot: string,
  providerId: string,
  projectId: string,
): string {
  return providerStatePath(
    projectCacheRoot(projectsRoot, providerId, projectId),
    providerId,
    "idmap.json",
  );
}

export function idMapPathForCacheRoot(cacheRoot: string, providerId: string): string {
  return providerStatePath(cacheRoot, providerId, "idmap.json");
}

export function syncStatePathForCacheRoot(cacheRoot: string, providerId: string): string {
  return providerStatePath(cacheRoot, providerId, "sync-state.json");
}

export function providerStateDir(cacheRoot: string, providerId: string): string {
  return joinPath(cacheRoot, ".typeward", "integrations", providerStateSegment(providerId));
}

/**
 * Where the state directory sat before provider ids were escaped. The raw id is
 * a legal directory name on macOS and Linux, so installs that synced there
 * already hold their cursor and manifest under it; the engine adopts one before
 * reading its baseline. Equal to `providerStateDir` for an id that needs no
 * escaping, which is every id but WebDAV's.
 */
export function legacyProviderStateDir(cacheRoot: string, providerId: string): string {
  return joinPath(cacheRoot, ".typeward", "integrations", providerId);
}

function providerStatePath(cacheRoot: string, providerId: string, fileName: string): string {
  return joinPath(providerStateDir(cacheRoot, providerId), fileName);
}

export function normalizeRemoteRelPath(relPath: string): NormalizedRelPath {
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
  // Reject the internal sidecar dir at any depth, case-insensitively: on
  // Windows / default macOS a remote file named `.Typeward/...` would
  // otherwise normalize to the real sidecar and let malicious remote content
  // overwrite snapshots, the sync cursor, or the id<->path map.
  if (segments.some((segment) => segment.toLowerCase() === ".typeward")) {
    throw new Error(`Remote path '${relPath}' targets Typeward's internal state`);
  }
  return segments.join("/") as NormalizedRelPath;
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
