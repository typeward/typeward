import { profile, profileLocalId } from "~/stores/settings-store";
import type { CommentAuthor } from "./types";

/**
 * What a comment is signed with when the profile has no display name yet.
 * Every install ends up with one (Rust seeds it from the OS account on first
 * run), so this is the fallback for a profile the user has explicitly cleared.
 */
export const UNNAMED_AUTHOR = "Unnamed";

/** Who this install writes review comments as. */
export function localAuthor(): CommentAuthor {
  return {
    id: profileLocalId(),
    name: profile().displayName.trim() || UNNAMED_AUTHOR,
  };
}

/**
 * Whether the identity Rust mints at startup has reached the renderer. Comments
 * cannot be written before it has: a shard has to be named after its author, and
 * writing one under an empty id would both collide with every other unnamed
 * install and lose this install's threads once the real id arrived.
 */
export function hasLocalIdentity(): boolean {
  return profileLocalId() !== "";
}

/** How a comment's author renders: the local user is "You", everyone else by name. */
export function authorLabel(authorId: string | undefined, authorName: string): string {
  if (authorId !== undefined && authorId !== "" && authorId === profileLocalId()) {
    return "You";
  }
  return authorName.trim() || UNNAMED_AUTHOR;
}

/** True when a comment or thread was written by this install. */
export function isLocalAuthor(authorId: string | undefined): boolean {
  return authorId !== undefined && authorId !== "" && authorId === profileLocalId();
}
