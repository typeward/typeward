/**
 * The library's active filter. Session-scoped in ProjectsScreen (resets on
 * revisit); the sidebar drives it and the project pipeline reads it.
 */
export type LibrarySelection =
  | { kind: "all" }
  | { kind: "yours" }
  | { kind: "shared" }
  | { kind: "archive" }
  | { kind: "trash" }
  | { kind: "space"; id: string }
  | { kind: "tag"; tag: string };

export function sameSelection(a: LibrarySelection, b: LibrarySelection): boolean {
  if (a.kind !== b.kind) return false;
  if (a.kind === "space" && b.kind === "space") return a.id === b.id;
  if (a.kind === "tag" && b.kind === "tag") return a.tag === b.tag;
  return true;
}
