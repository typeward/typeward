/**
 * Integration provider interfaces (Phase 0 of the integrations program).
 *
 * Every integration — reference managers, cloud storage, VCS, AI providers,
 * grammar checkers, template sources — implements one of these. The seam
 * lets the rest of the app stay format-agnostic and provider-agnostic; UI
 * code talks to interfaces, not Zotero / OneDrive / Anthropic by name.
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

export interface CitationProvider extends IntegrationProvider {
  category: "references";
  /**
   * Lightweight search for picker UIs. Returns metadata only (title,
   * authors, year). Empty query is allowed and should surface "recent" or
   * "all" entries up to a sensible limit.
   */
  searchLibrary(query: string): Promise<Citation[]>;
  /** Full BibTeX for one entry, identified by its citation key. */
  fetchEntry(key: string): Promise<BibTexEntry>;
  /**
   * Full BibTeX for every entry the provider exposes. The aggregator
   * concatenates these across providers, dedupes by key, and writes the
   * result into `<project>/.typeward/citations/library.bib` so texlab /
   * tinymist / busytex see one source of truth.
   *
   * Providers that don't have a persistent library (e.g. the DOI lookup
   * resolver) return an empty string here.
   */
  exportAllAsBibTex(): Promise<string>;
  watchChanges?(): AsyncIterable<LibraryChange>;
}

// ----- Cloud filesystem --------------------------------------------------

export interface RemoteFolder {
  /** Provider-scoped opaque id. For path-based providers, this is the path. */
  id: string;
  name: string;
  parentId?: string;
  modifiedAt?: string;
}

export interface SyncResult {
  changedFiles: number;
  conflicts: string[];
  /** Cursor to persist for the next delta call. */
  cursor?: string;
}

export interface DeltaResult {
  changes: Array<{
    kind: "added" | "modified" | "removed";
    /** Project-relative path. */
    relPath: string;
  }>;
  nextCursor: string;
}

export interface CloudFsProvider extends IntegrationProvider {
  category: "cloud";
  listRoots(): Promise<RemoteFolder[]>;
  pull(remoteId: string, localCachePath: string): Promise<SyncResult>;
  push(localCachePath: string, remoteId: string): Promise<SyncResult>;
  delta(cursor: string | undefined): Promise<DeltaResult>;
}

// ----- AI ----------------------------------------------------------------

export interface ModelInfo {
  id: string;
  displayName: string;
  contextWindow?: number;
  supportsStreaming: boolean;
}

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
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
  /** Entitlement key required to use this template; checked at instantiate time. */
  entitlement?: string;
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

// ----- Entitlements ------------------------------------------------------

export type Tier = "free" | "pro" | "team";

/**
 * Entitlement keys identify a gated feature. Stable, prefixed by category
 * so they group naturally in the settings UI and in the Supabase
 * `entitlements_map` table.
 *
 * Naming rule: dot-separated, lowercase, never repurposed once shipped.
 */
export type EntitlementKey =
  | `integrations.${string}`
  | `templates.${string}`
  | `features.${string}`;

export interface EntitlementSource {
  current(): Tier;
  has(key: EntitlementKey): boolean;
  reasonIfMissing(key: EntitlementKey): "no-account" | "wrong-tier" | "expired" | undefined;
}
