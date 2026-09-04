import type { LspSession } from "~/lib/lsp/cm6";
import type { OutlineItem } from "~/lib/outline/parse";

/**
 * `textDocument/documentSymbol` → OutlineItem tree. Handles both wire shapes
 * (hierarchical DocumentSymbol[] and flat SymbolInformation[]). Returns null
 * when the server errors / doesn't support the method (caller falls back to the
 * regex parser).
 */

// LSP SymbolKind values that are clearly leaf noise (labels, citation keys,
// constants) rather than document structure. Denylist rather than allowlist so
// an unrecognized structure kind from a given server still shows up; verify per
// server at integration and extend if a server surfaces noise.
const NON_STRUCTURE_KINDS = new Set<number>([
  14, // Constant
  15, // String (texlab uses this for labels)
  16, // Number
  17, // Boolean
  20, // Key
  21, // Null
  22, // EnumMember
]);

interface LspDocumentSymbol {
  name: string;
  kind: number;
  range: { start: { line: number } };
  selectionRange?: { start: { line: number } };
  children?: LspDocumentSymbol[];
}

interface LspSymbolInformation {
  name: string;
  kind: number;
  location: { range: { start: { line: number } } };
  containerName?: string;
}

export async function requestDocumentSymbols(
  session: LspSession,
  uri: string,
): Promise<OutlineItem[] | null> {
  let raw: unknown;
  try {
    raw = await session.client.request("textDocument/documentSymbol", {
      textDocument: { uri },
    });
  } catch {
    return null;
  }
  // Parsing is also guarded: a non-spec-compliant server (null array elements, a
  // DocumentSymbol missing `range`) must fall back to the regex parser, not throw
  // out of the resource fetcher into the app ErrorBoundary.
  try {
    if (raw == null || !Array.isArray(raw)) return null;
    if (raw.length === 0) return [];
    // Flat SymbolInformation carries `location`; hierarchical DocumentSymbol
    // carries `range` + optional `children`.
    const first = raw[0];
    if (first && typeof first === "object" && "location" in first) {
      return fromFlat(raw as LspSymbolInformation[]);
    }
    return fromHierarchical(raw as LspDocumentSymbol[], 1);
  } catch {
    return null;
  }
}

function fromHierarchical(syms: LspDocumentSymbol[], level: number): OutlineItem[] {
  const out: OutlineItem[] = [];
  for (const s of syms) {
    const keep = !NON_STRUCTURE_KINDS.has(s.kind);
    const line = (s.selectionRange?.start.line ?? s.range.start.line) + 1;
    const children = fromHierarchical(s.children ?? [], keep ? level + 1 : level);
    if (keep) {
      out.push({ title: s.name, level, line, children });
    } else {
      // Drop the leaf but keep any structural descendants it may hold.
      out.push(...children);
    }
  }
  return out;
}

function fromFlat(syms: LspSymbolInformation[]): OutlineItem[] {
  return syms
    .filter((s) => !NON_STRUCTURE_KINDS.has(s.kind))
    .map((s) => ({
      title: s.name,
      level: 1,
      line: s.location.range.start.line + 1,
      children: [] as OutlineItem[],
    }));
}
