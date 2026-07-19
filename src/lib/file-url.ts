/**
 * Local-asset URL helpers shared by the markdown preview and the visual
 * editor's figure widgets. The security posture lives HERE, once: only
 * project-relative paths resolve (no absolute paths, no parent traversal,
 * no NULs), and callers build `file://` URLs exclusively from a trusted
 * base directory + a safe relative path — remote/beacon URLs never enter.
 */

export function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const encoded = normalized
    .split("/")
    .map((part, index) =>
      index === 0 && /^[A-Za-z]:$/.test(part) ? part : encodeURIComponent(part),
    )
    .join("/");
  return /^[A-Za-z]:\//.test(normalized) ? `file:///${encoded}` : `file://${encoded}`;
}

export function safeRelativePath(url: string): string | null {
  const trimmed = url.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/")) return null;

  const normalized = trimmed.replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

/** `baseDir` + safe relative path → file URL, or null when unsafe. */
export function resolveProjectAsset(baseDir: string, rel: string): string | null {
  const safeRel = safeRelativePath(rel);
  if (!safeRel) return null;
  const root = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
  if (root === "") return null;
  return fileUrlFromPath(`${root}/${safeRel}`);
}
