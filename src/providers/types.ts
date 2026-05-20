import type { CompileResult, Project } from "~/adapters/types";

/**
 * A CompileProvider knows how to turn a Project into an artifact. Examples:
 *   - "system-tex"   → spawns latexmk/pdflatex from the user's PATH
 *   - "tectonic"     → invokes the bundled Tectonic binary
 *   - "typst"        → typst CLI sidecar
 *   - "busytex"      → texlyre-busytex WASM (tablet only, Phase 3)
 *
 * Adapters delegate to a provider chosen by the project's settings; the
 * resolution rules live in src/lib/compile (not in this file).
 */
export interface CompileProvider {
  id: string;
  /** Whether this provider can handle the given project at all. */
  supports(project: Project): boolean;
  compile(project: Project): Promise<CompileResult>;
}

export type PreviewKind = "pdf";

/**
 * Marker interface for now — the actual Preview component is rendered by the
 * editor shell and reads `previewKind` off the active EditorAdapter. This
 * type exists so future plugin previews have a registration shape.
 */
export interface PreviewProvider {
  id: string;
  kind: PreviewKind;
}

/**
 * Lifecycle ops use Tauri `invoke` (start/stop are one-shot). Live LSP traffic
 * — completions, diagnostics, hovers — is brokered through Tauri event
 * channels (`emit`/`listen`) instead, so JSON-RPC streaming doesn't jitter.
 * The handle returned by `start` lets the caller stop the server later.
 */
export interface LspProvider {
  id: string;
  /** Must match an EditorAdapter.languageId so completions route correctly. */
  languageId: string;
  start(project: Project): Promise<LspHandle>;
}

export interface LspHandle {
  id: string;
  stop(): Promise<void>;
}
