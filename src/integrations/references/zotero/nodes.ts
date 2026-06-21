/**
 * Shared library/collection-tree primitives for the two Zotero providers
 * (local and web). The node-id scheme and resolver are identical across them;
 * only the transport (loopback no-auth vs. api.zotero.org with an API key)
 * differs, so it lives in each provider.
 *
 * Node id grammar:
 *   user                       personal library root
 *   group/<gid>                group library root
 *   user/c/<collKey>           collection in the personal library
 *   group/<gid>/c/<collKey>    collection in a group library
 */

export interface LibraryRef {
  /** "user" for the personal library, or the numeric group id. */
  id: string;
  name: string;
  kind: "user" | "group";
}

export interface CollectionRef {
  key: string;
  name: string;
  /** Parent collection key, or null for a top-level collection. */
  parent: string | null;
}

export interface RawCollection extends CollectionRef {
  /** Zotero marks trashed collections `deleted` (the top of a trashed subtree). */
  deleted: boolean;
}

/**
 * Drop trashed collections and every descendant of a trashed one. Zotero's
 * `/collections` API returns trashed collections (`deleted: true`) and their
 * children (often not individually flagged) — it has no `includeTrashed` filter
 * like `/items` — so they'd otherwise appear in the picker even though the
 * Zotero app/web hide them.
 */
export function pruneTrashedCollections(raw: RawCollection[]): CollectionRef[] {
  const byKey = new Map(raw.map((c) => [c.key, c]));
  const isTrashed = (key: string, seen: Set<string>): boolean => {
    const c = byKey.get(key);
    if (!c || seen.has(key)) return false;
    seen.add(key);
    if (c.deleted) return true;
    return c.parent ? isTrashed(c.parent, seen) : false;
  };
  return raw
    .filter((c) => !isTrashed(c.key, new Set()))
    .map(({ key, name, parent }) => ({ key, name, parent }));
}

export type ResolvedNode =
  | { kind: "library"; lib: LibraryRef }
  | { kind: "collection"; lib: LibraryRef; collKey: string };

/**
 * Validates a library/collection/folder key from a (shape-untrusted) API
 * response before it goes into a node id or request URL. Zotero keys are 8
 * alphanumeric chars; Mendeley folder ids are 36-char UUIDs (hyphens). Allow
 * alnum + `-`/`_` up to 64 — covers both while still blocking `/`, `.` (so no
 * `..` traversal), whitespace, and other URL/path-injection characters.
 */
export function isValidKey(key: string): boolean {
  return /^[A-Za-z0-9_-]{1,64}$/.test(key);
}

/** Stable picker node id for a library root. */
export function libNodeId(lib: LibraryRef): string {
  return lib.kind === "user" ? "user" : `group/${lib.id}`;
}

/** Stable picker node id for a collection within a library. */
export function collNodeId(lib: LibraryRef, collKey: string): string {
  return `${libNodeId(lib)}/c/${collKey}`;
}

/** Map a node id back to a library (and collection key) from a known set. */
export function resolveNode(
  id: string,
  libraries: LibraryRef[],
): ResolvedNode | null {
  const parts = id.split("/");
  let lib: LibraryRef | undefined;
  let collKey: string | undefined;
  if (parts[0] === "user") {
    lib = libraries.find((l) => l.kind === "user");
    if (parts[1] === "c") collKey = parts[2];
    else if (parts.length > 1) return null;
  } else if (parts[0] === "group") {
    lib = libraries.find((l) => l.kind === "group" && l.id === parts[1]);
    if (parts[2] === "c") collKey = parts[3];
    else if (parts.length > 2) return null;
  } else {
    return null;
  }
  if (!lib) return null;
  if (collKey !== undefined) {
    if (!isValidKey(collKey)) return null;
    return { kind: "collection", lib, collKey };
  }
  return { kind: "library", lib };
}
