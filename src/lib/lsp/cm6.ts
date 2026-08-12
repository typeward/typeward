/**
 * Hand-rolled LSP ↔ CodeMirror 6 integration. Skips
 * codemirror-languageserver because it's coupled to @open-rpc/client-js
 * WebSocket transport, and bridging that to our Tauri event channels is
 * more painful than the small surface we need anyway.
 *
 * Implements:
 *   - textDocument/didOpen on plugin mount
 *   - textDocument/didChange (200ms debounce) on doc edits
 *   - textDocument/didClose on plugin destroy
 *   - textDocument/publishDiagnostics → CM6 linter diagnostics
 *   - textDocument/completion → CM6 autocompletion source
 *
 * Initialize / initialized live in {@link initSession}; per-document
 * lifecycle is handled by {@link lspDocumentExtensions}.
 */

import {
  autocompletion,
  type Completion,
  type CompletionContext,
  type CompletionResult,
} from "@codemirror/autocomplete";
import { linter, type Diagnostic } from "@codemirror/lint";
import { ChangeSet, StateEffect, StateField, type Extension, type Text } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { JsonRpcClient } from "./client";
import { perfMeasure, perfRecord } from "../perf-marks";

// ---- Session setup --------------------------------------------------------

export interface LspSession {
  client: JsonRpcClient;
  rootUri: string;
  /**
   * The server's advertised capabilities from the initialize result —
   * `textDocumentSync`, provider flags, etc. Null only if the server answered
   * with a shape that carried none. Feature gates (incremental sync, rename,
   * references) must read this instead of assuming.
   */
  serverCapabilities: Record<string, unknown> | null;
  /** Build a CodeMirror Extension set that hooks the given document into this session. */
  document(opts: { uri: string; languageId: string }): Extension;
  /** Send shutdown/exit and tear down the transport. Safe to call once. */
  stop(): Promise<void>;
}

/**
 * Spawn the LSP for `languageId` and complete the LSP initialize handshake.
 * Returns a session you can attach documents to.
 */
export async function initSession(
  client: JsonRpcClient,
  rootUri: string,
  capabilities: Record<string, unknown> = DEFAULT_CLIENT_CAPABILITIES,
): Promise<LspSession> {
  const initResult = (await client.request("initialize", {
    processId: null,
    rootUri,
    capabilities,
    workspaceFolders: [{ uri: rootUri, name: "project" }],
  })) as { capabilities?: Record<string, unknown> } | null;
  client.notify("initialized", {});
  const serverCapabilities = initResult?.capabilities ?? null;
  // textDocumentSync is either a kind number or { change: kind }. Kind 2 =
  // Incremental; anything else (Full, None, or absent) uses full-content sync.
  const syncCap = serverCapabilities?.textDocumentSync;
  const changeKind =
    typeof syncCap === "number"
      ? syncCap
      : ((syncCap as { change?: number } | undefined)?.change ?? 1);
  const changeSync: ChangeSync = changeKind === 2 ? "incremental" : "full";

  let stopped = false;
  return {
    client,
    rootUri,
    serverCapabilities,
    document(opts) {
      return lspDocumentExtensions({ client, changeSync, ...opts });
    },
    async stop() {
      if (stopped) return;
      stopped = true;
      try {
        await client.request("shutdown", null, 2000);
      } catch {
        /* best effort */
      }
      client.notify("exit", null);
      await client.stop();
    },
  };
}

// ---- Document extension ---------------------------------------------------

type ChangeSync = "full" | "incremental";

interface LspDocOptions {
  client: JsonRpcClient;
  uri: string;
  languageId: string;
  /** How to sync edits — from the server's advertised textDocumentSync. */
  changeSync?: ChangeSync;
}

/** Lets the completion source force-flush the lifecycle plugin's pending
 *  debounced didChange, so the server isn't queried against stale text. */
interface DocSync {
  flush: () => void;
}

function lspDocumentExtensions(opts: LspDocOptions): Extension {
  const sync: DocSync = { flush: () => {} };
  // StateField + Effect for LSP-pushed diagnostics. linter() reads from here.
  return [diagnosticsField, lifecyclePlugin(opts, sync), linter((view) =>
    view.state.field(diagnosticsField),
  ), autocompletion({ override: [completionSource(opts, sync)] })];
}

const setLspDiagnostics = StateEffect.define<Diagnostic[]>();

const diagnosticsField = StateField.define<Diagnostic[]>({
  create: () => [],
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setLspDiagnostics)) return e.value;
    }
    return value;
  },
});

/** LSP 0-based line/character position for a UTF-16 offset in `doc`. CM6
 *  offsets and LSP's default UTF-16 positionEncoding share code-unit indexing,
 *  so no re-encoding is needed. */
function offsetToLspPos(doc: Text, pos: number): { line: number; character: number } {
  const line = doc.lineAt(pos);
  return { line: line.number - 1, character: pos - line.from };
}

/**
 * Convert a composed ChangeSet (against `startDoc`) into LSP incremental
 * contentChanges. Every range is expressed in `startDoc` coordinates, and the
 * changes are emitted HIGHEST-position-first so the server applies them
 * top-to-bottom without an earlier edit shifting a later range's coordinates.
 */
export function changesToLspContentChanges(
  changes: ChangeSet,
  startDoc: Text,
): Array<{ range: { start: object; end: object }; text: string }> {
  const out: Array<{ range: { start: object; end: object }; text: string }> = [];
  changes.iterChanges((fromA, toA, _fromB, _toB, inserted) => {
    out.push({
      range: {
        start: offsetToLspPos(startDoc, fromA),
        end: offsetToLspPos(startDoc, toA),
      },
      text: inserted.toString(),
    });
  });
  return out.reverse();
}

function lifecyclePlugin(opts: LspDocOptions, sync: DocSync) {
  const incremental = opts.changeSync === "incremental";
  return ViewPlugin.define((view: EditorView) => {
    let version = 1;
    let debounce: ReturnType<typeof setTimeout> | undefined;
    // Full-sync path: a boolean is enough (the whole doc is re-serialized).
    let dirty = false;
    // Incremental path: accumulate the raw edits and the doc they apply to, so
    // one debounced notification carries every keystroke as tiny ranges
    // instead of the megabyte doc.toString() a large file would otherwise
    // send on every flush.
    let pending: ChangeSet | null = null;
    let pendingStartDoc: Text | null = null;

    const sendDidChange = (): void => {
      if (incremental) {
        if (!pending || !pendingStartDoc) return;
        opts.client.notify("textDocument/didChange", {
          textDocument: { uri: opts.uri, version: version++ },
          contentChanges: changesToLspContentChanges(pending, pendingStartDoc),
        });
        pending = null;
        pendingStartDoc = null;
      } else {
        // Serialized lazily at send time — doing it per keystroke would be an
        // O(n) rope→string walk discarded by the next edit.
        opts.client.notify("textDocument/didChange", {
          textDocument: { uri: opts.uri, version: version++ },
          contentChanges: [{ text: view.state.doc.toString() }],
        });
        dirty = false;
      }
    };
    const flushPending = (): void => {
      if (debounce) {
        clearTimeout(debounce);
        debounce = undefined;
      }
      if (incremental ? pending !== null : dirty) sendDidChange();
    };
    sync.flush = flushPending;

    // didOpen
    opts.client.notify("textDocument/didOpen", {
      textDocument: {
        uri: opts.uri,
        languageId: opts.languageId,
        version: version++,
        text: view.state.doc.toString(),
      },
    });

    // Subscribe to diagnostics for this document.
    const unsubDiag = opts.client.onNotification(
      "textDocument/publishDiagnostics",
      (params) => {
        const p = params as { uri: string; diagnostics: LspDiagnostic[] };
        if (!p?.uri || !sameDocumentUri(p.uri, opts.uri)) return;
        const cmDiags = (p.diagnostics ?? [])
          .map((d) => lspToCmDiagnostic(d, view))
          .filter((d): d is Diagnostic => d !== null);
        view.dispatch({ effects: setLspDiagnostics.of(cmDiags) });
      },
    );

    return {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (incremental) {
          // Compose successive edits so the flush sends one consistent delta.
          // The window's anchor doc is the state before the first edit.
          if (pending === null) pendingStartDoc = update.startState.doc;
          pending = pending ? pending.compose(update.changes) : update.changes;
        } else {
          dirty = true;
        }
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          debounce = undefined;
          sendDidChange();
        }, 200);
      },
      destroy() {
        if (debounce) clearTimeout(debounce);
        sync.flush = () => {};
        unsubDiag();
        opts.client.notify("textDocument/didClose", {
          textDocument: { uri: opts.uri },
        });
      },
    };
  });
}

// ---- Diagnostic conversion ------------------------------------------------

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

export interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // Error | Warning | Information | Hint
  message: string;
  source?: string;
  code?: string | number;
}

export function lspToCmDiagnostic(d: LspDiagnostic, view: EditorView): Diagnostic | null {
  const from = lspPosToOffset(d.range.start, view);
  const to = lspPosToOffset(d.range.end, view);
  if (from == null || to == null) return null;
  return {
    from,
    to: Math.max(from, to),
    severity:
      d.severity === 2
        ? "warning"
        : d.severity === 3 || d.severity === 4
          ? "info"
          : "error",
    message: d.message,
    source: d.source,
  };
}

export function lspPosToOffset(pos: LspPosition, view: EditorView): number | null {
  const doc = view.state.doc;
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1); // CM6 lines are 1-based
  return Math.min(line.from + pos.character, line.to);
}

export function cmOffsetToLspPos(offset: number, view: EditorView): LspPosition {
  const line = view.state.doc.lineAt(offset);
  return { line: line.number - 1, character: offset - line.from };
}

// ---- Completion source ----------------------------------------------------

interface LspCompletionItem {
  label: string;
  kind?: number;
  detail?: string;
  documentation?: string | { value: string };
  insertText?: string;
  filterText?: string;
}

interface LspCompletionList {
  isIncomplete?: boolean;
  items: LspCompletionItem[];
}

function completionSource(opts: LspDocOptions, sync: DocSync) {
  let firstUsefulRecorded = false;
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!ctx.view) return null;
    // Push any debounced edits to the server before asking for completions,
    // otherwise it resolves positions against text up to 200ms stale — exactly
    // during fast typing, when completion matters most.
    sync.flush();
    const pos = cmOffsetToLspPos(ctx.pos, ctx.view);
    const t0 = performance.now();
    let raw: LspCompletionList | LspCompletionItem[] | null;
    try {
      raw = (await opts.client.request("textDocument/completion", {
        textDocument: { uri: opts.uri },
        position: pos,
        context: { triggerKind: ctx.explicit ? 1 : 2 },
      }, 4000)) as LspCompletionList | LspCompletionItem[] | null;
    } catch {
      return null;
    }
    if (!raw) return null;
    const items = Array.isArray(raw) ? raw : raw.items;
    if (!items?.length) return null;
    if (!firstUsefulRecorded) {
      firstUsefulRecorded = true;
      perfRecord("lsp.completion.first-useful", performance.now() - t0, `items=${items.length}`);
      perfMeasure("open-to-first-completion", "project-open", opts.uri, 120_000);
    }

    // Find where the current "word" starts (back over LaTeX-friendly chars).
    const word = ctx.matchBefore(/[\\@\w][@\w]*/);
    const from = word ? word.from : ctx.pos;

    const options: Completion[] = items.map((i) => ({
      label: i.label,
      apply: i.insertText ?? i.label,
      detail: i.detail,
      info: typeof i.documentation === "string" ? i.documentation : i.documentation?.value,
      type: kindToType(i.kind),
    }));

    return { from, options, validFor: /^[\\@\w][@\w]*$/ };
  };
}

export function kindToType(kind?: number): string | undefined {
  // Maps the LSP CompletionItemKind subset we care about onto CodeMirror's
  // free-form "type" strings (which become autocomplete icon classes).
  switch (kind) {
    case 3: return "function";
    case 6: return "variable";
    case 7: return "class";
    case 14: return "keyword";
    case 15: return "constant";
    case 17: return "type";
    case 21: return "constant";
    default: return "text";
  }
}

// ---- Default client capabilities -----------------------------------------

const DEFAULT_CLIENT_CAPABILITIES = {
  textDocument: {
    synchronization: {
      didSave: true,
      willSave: false,
      willSaveWaitUntil: false,
    },
    publishDiagnostics: {
      relatedInformation: false,
      versionSupport: false,
    },
    completion: {
      completionItem: {
        snippetSupport: false,
        commitCharactersSupport: false,
        documentationFormat: ["plaintext"],
        deprecatedSupport: false,
        preselectSupport: false,
      },
      contextSupport: true,
    },
    hover: { contentFormat: ["plaintext"] },
    documentSymbol: {
      hierarchicalDocumentSymbolSupport: true,
    },
  },
  workspace: {
    workspaceFolders: true,
  },
};

// Re-export so callers can build URIs the same way.
export function pathToFileUri(absPath: string): string {
  // Windows: C:\foo\bar -> file:///C:/foo/bar
  // Unix: /foo/bar -> file:///foo/bar
  const normalized = absPath.replace(/\\/g, "/");
  // Escape the characters that would otherwise change the URI's *structure*
  // before parsing: `#`/`?` start a fragment/query, and a bare `%` followed by
  // hex digits would be read as an escape and decoded server-side into a
  // different path. Spaces and non-ASCII are left for the URL parser.
  const escaped = normalized
    .replace(/%/g, "%25")
    .replace(/#/g, "%23")
    .replace(/\?/g, "%3F");
  const raw = /^[a-zA-Z]:/.test(normalized)
    ? `file:///${escaped}`
    : `file://${escaped}`;
  // Round-trip through the WHATWG URL parser so the URI we register is already
  // in the normalized form a server re-serializes to. texlab/tinymist parse our
  // URI with Rust's `url` crate (same standard) and echo the normalized spelling
  // on publishDiagnostics; handing them an unencoded space meant their
  // `.../First%20Last/...` never string-equalled our raw-space URI and every
  // diagnostic was silently discarded.
  try {
    return new URL(raw).href;
  } catch {
    return raw;
  }
}

/// Compare two document URIs for identity, tolerating equivalent spellings.
/// Percent-encoding sets differ between implementations (`@`, `!`, `(`… are
/// escaped by some and not others), so raw string equality is too strict for
/// matching a server notification to the document we opened.
export function sameDocumentUri(a: string, b: string): boolean {
  if (a === b) return true;
  return canonicalUri(a) === canonicalUri(b);
}

function canonicalUri(uri: string): string {
  try {
    return decodeURIComponent(new URL(uri).href);
  } catch {
    return uri;
  }
}
