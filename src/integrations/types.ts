/**
 * Integration provider interfaces (Phase 0 of the integrations program).
 *
 * Every integration — reference managers, cloud storage, VCS, AI providers,
 * grammar checkers, template sources — implements one of these. The seam
 * lets the rest of the app stay format-agnostic and provider-agnostic; UI
 * code talks to interfaces, not Zotero / WebDAV / Anthropic by name.
 *
 * Providers are registered through per-category registries (see
 * src/integrations/<category>/registry.ts files added in later phases) and
 * surface in settings + the command palette.
 */

import type { Diagnostic, Project } from "~/adapters/types";

export type IntegrationCategory =
  | "references"
  | "cloud"
  | "vcs"
  | "ai"
  | "grammar"
  | "templates";

export type ProviderStatus = "unconfigured" | "ready" | "error";

export interface IntegrationProvider {
  id: string;
  category: IntegrationCategory;
  displayName: string;
  status(): Promise<ProviderStatus>;
}

// ----- References --------------------------------------------------------

export interface Citation {
  /** BibTeX key — used directly in `\cite{key}` / `@key`. */
  key: string;
  title: string;
  authors: string[];
  year?: number;
  doi?: string;
  /** Provider-specific opaque id for round-tripping. */
  providerEntryId?: string;
  /**
   * Human-readable source library this entry came from (e.g. a Zotero
   * "My Library" / group name). Optional — the references panel falls back to
   * the provider's display name when unset, so entries always group somewhere.
   */
  library?: string;
}

export interface BibTexEntry {
  key: string;
  /** Full BibTeX entry source ready to write into a `.bib` file. */
  source: string;
}

export interface LibraryChange {
  kind: "added" | "modified" | "removed";
  key: string;
}

/**
 * A node in a provider's library tree — either a top-level library (a Zotero
 * personal / group library, or a single-library provider's whole catalog) or a
 * collection (folder) nested within one. The references picker renders these as
 * an indented tree and passes the chosen node's `id` back as `searchLibrary`'s
 * `library` argument.
 */
export interface LibraryNode {
  /** Stable, provider-defined id. Opaque to the picker. */
  id: string;
  /** This node's own label (folder / library name), not the full path. */
  name: string;
  /** Parent node id; `undefined` for a top-level library root. */
  parentId?: string;
  kind: "library" | "collection";
}

export interface CitationProvider extends IntegrationProvider {
  category: "references";
  /**
   * Lightweight search for picker UIs. Returns metadata only (title,
   * authors, year). Empty query is allowed and should surface "recent" or
   * "all" entries up to a sensible limit.
   *
   * `library` restricts results to one node (see `listLibraryNodes`) by its
   * `id`. A provider that doesn't recognize the id returns `[]`.
   */
  searchLibrary(query: string, library?: string): Promise<Citation[]>;
  /**
   * Optional: the provider's top-level libraries (a Zotero personal/group
   * library, or a single-library provider's catalog), as `kind:"library"`
   * nodes. **Fast** — must NOT discover collections; the picker loads those
   * lazily via `listCollections` only once a library is selected. When absent,
   * the provider is treated as a single library named by `displayName`.
   */
  listLibraryNodes?(): Promise<LibraryNode[]>;
  /**
   * Optional: the collections (folders / subfolders) within one library, by its
   * node id, as `kind:"collection"` nodes. `parentId` (another collection's id)
   * nests subcollections; a top-level collection has `parentId` undefined.
   * Loaded on demand when the user picks a library.
   */
  listCollections?(libraryNodeId: string): Promise<LibraryNode[]>;
  /**
   * Optional: drop any internal caches so the next call refetches from source.
   * The references panel's Refresh button calls this before re-aggregating, so
   * a freshly added item / collection shows up immediately rather than after a
   * cache TTL lapses.
   */
  invalidate?(): void;
  /** Full BibTeX for one entry, identified by its citation key. */
  fetchEntry(key: string): Promise<BibTexEntry>;
  /**
   * Full BibTeX for every entry the provider exposes. The aggregator
   * concatenates these across providers, dedupes by key, and writes the
   * result into `<project>/.typeward/citations/library.bib` so texlab /
   * tinymist / the compile engine see one source of truth.
   *
   * Providers that don't have a persistent library (e.g. the DOI lookup
   * resolver) return an empty string here.
   */
  exportAllAsBibTex(): Promise<string>;
  watchChanges?(): AsyncIterable<LibraryChange>;
}

// ----- Cloud filesystem --------------------------------------------------

export interface RemoteFolder {
  /** Provider-scoped opaque id. For path-based providers (WebDAV), this is
   * the path; for id-based providers it's the opaque file id. */
  id: string;
  name: string;
  parentId?: string;
  modifiedAt?: string;
}

export interface RemoteFile {
  /** Provider-scoped opaque id of this file. */
  id: string;
  /** Path relative to the project root inside the cache. */
  relPath: string;
  /** Provider-reported revision tag (etag, rev, content_hash, etc.). */
  rev?: string;
  /** Provider-reported size in bytes when known. */
  size?: number;
  modifiedAt?: string;
}

export type DeltaChange =
  | { kind: "added" | "modified"; file: RemoteFile }
  | { kind: "removed"; relPath: string; id?: string };

export interface DeltaResult {
  changes: DeltaChange[];
  /** Opaque cursor to pass into the next `delta()` call. */
  nextCursor: string;
  /** Provider hint that more pages remain; engine should loop. */
  hasMore?: boolean;
}

/**
 * Per-file operations. Engine drives these from the orchestration layer;
 * provider implementations only need to know how to do their own transport.
 */
export interface CloudFsProvider extends IntegrationProvider {
  category: "cloud";
  /** Folders the user can pick as a project root. */
  listRoots(): Promise<RemoteFolder[]>;
  /** Initial enumeration of every file under a remote root, recursive. */
  enumerateFiles(rootId: string): Promise<{ files: RemoteFile[]; cursor: string }>;
  /** Download one file's bytes to the given absolute local path. */
  downloadFile(file: RemoteFile, destAbsPath: string): Promise<void>;
  /** Upload local bytes to a remote relative path under a root folder. */
  uploadFile(
    rootId: string,
    relPath: string,
    sourceAbsPath: string,
  ): Promise<RemoteFile>;
  /** Delete a remote file. */
  deleteRemoteFile(rootId: string, file: RemoteFile): Promise<void>;
  /** Pull changes since `cursor`. */
  delta(rootId: string, cursor: string | undefined): Promise<DeltaResult>;
}

export type SyncPhase =
  | "idle"
  | "pulling"
  | "pushing"
  | "conflict"
  | "error"
  /** Network-shaped failure — transient, the engine retries on its own. */
  | "offline"
  /** A cloud-bound project whose engine cannot start (credentials gone) —
   *  persistent until the user reconnects. */
  | "disconnected";

export interface SyncStatus {
  phase: SyncPhase;
  /** Last full sync completion, when known. */
  lastSyncAt?: number;
  /** Free-form message for the badge tooltip. */
  message?: string;
  /** Project-relative paths that hit conflicts on the most recent pass. */
  conflicts: string[];
}

// ----- AI ----------------------------------------------------------------

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsStreaming: boolean;
}

/**
 * An image attached to a chat message. `base64` is the raw payload (no data:
 * prefix); persisted conversation records store a stub with `base64: ""` so
 * the JSONL sidecar never carries megabytes of image data.
 */
export interface ChatAttachment {
  kind: "image";
  mime: string;
  base64: string;
  name?: string;
  /** Decoded size in bytes (for caps + "image — 1.2 MB" placeholders). */
  bytes: number;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
  /** Image attachments (user turns only). Mapped per provider wire format. */
  attachments?: ChatAttachment[];
}

export interface ChatChunk {
  delta: string;
  /** Set on the final chunk. */
  done?: boolean;
}

export interface ChatOptions {
  model: string;
  temperature?: number;
  maxTokens?: number;
  /** Abort signal mirrored across the IPC stream. */
  signal?: AbortSignal;
}

export interface AiProvider extends IntegrationProvider {
  category: "ai";
  models(): Promise<ModelInfo[]>;
  chat(messages: ChatMessage[], opts: ChatOptions): AsyncIterable<ChatChunk>;
}

// ----- Grammar -----------------------------------------------------------

export interface GrammarDiagnostic extends Diagnostic {
  /** Optional suggested replacements; the linter renders these as quick-fixes. */
  replacements?: string[];
}

export interface GrammarProvider extends IntegrationProvider {
  category: "grammar";
  lint(text: string, languageCode: string): Promise<GrammarDiagnostic[]>;
}

// ----- Templates ---------------------------------------------------------

export interface TemplateVariable {
  key: string;
  label: string;
  defaultValue: string;
  multiline?: boolean;
}

export interface TemplateManifest {
  id: string;
  name: string;
  description: string;
  format: "latex" | "typst";
  tags: string[];
  thumbnail?: string;
  rootFile: string;
  variables: TemplateVariable[];
}

export interface TemplateProvider extends IntegrationProvider {
  category: "templates";
  list(): Promise<TemplateManifest[]>;
  instantiate(
    id: string,
    destPath: string,
    vars: Record<string, string>,
  ): Promise<Project>;
}
