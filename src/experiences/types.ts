/**
 * A DocumentExperience owns the entire editor shell for a class of documents:
 * not just syntax, but layout, panels, persistence semantics, toolbar, and
 * compile/preview/run model. Picked at project creation; all downstream
 * routing branches from this value.
 *
 * Notebook is intentionally distinct from text — bolting cell execution onto
 * a single-body editor leads to a tangled architecture by Phase 2.
 */
export type DocumentExperience = "text" | "notebook" | "publishing";

export const DOCUMENT_EXPERIENCES = [
  "text",
  "notebook",
  "publishing",
] as const satisfies readonly DocumentExperience[];
