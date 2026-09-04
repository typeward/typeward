/**
 * Local-asset URL helpers shared by the markdown preview, the visual editor's
 * figure widgets, and the profile avatar. The security posture lives HERE,
 * once: a path is only ever turned into an asset URL when it is already
 * trusted, and document-supplied paths reach `fileUrlFromPath` exclusively via
 * `resolveProjectAsset`/`safeRelativePath` — a trusted base directory plus a
 * project-relative path with no absolute prefix, no parent traversal and no
 * NULs. Remote/beacon URLs never enter. The one bare `fileUrlFromPath` caller
 * (the avatar) passes an absolute path Rust produced under `<app_data>` from a
 * file the user picked, so no document ever chooses it.
 */

import { convertFileSrc } from "@tauri-apps/api/core";

/**
 * Map an absolute local path to a URL the webview will actually load as an
 * `<img>`/asset subresource. Raw `file://` URLs are refused by WKWebView and
 * WebKitGTK and blocked from the app origin by WebView2, so route through
 * Tauri's asset protocol via `convertFileSrc` (`asset://localhost/…`, or
 * `http://asset.localhost/…` on Windows). Falls back to a `file://` URL outside
 * a Tauri webview (unit tests / SSR), where `__TAURI_INTERNALS__` is absent.
 */
export function fileUrlFromPath(path: string): string {
  const normalized = path.replace(/\\/g, "/");
  const hasTauri =
    typeof window !== "undefined" &&
    (window as { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__ !==
      undefined;
  if (hasTauri) {
    return convertFileSrc(normalized);
  }
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
