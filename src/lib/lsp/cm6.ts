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
import { StateEffect, StateField, type Extension } from "@codemirror/state";
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import type { JsonRpcClient } from "./client";

// ---- Session setup --------------------------------------------------------

export interface LspSession {
  client: JsonRpcClient;
  rootUri: string;
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
  await client.request("initialize", {
    processId: null,
    rootUri,
    capabilities,
    workspaceFolders: [{ uri: rootUri, name: "project" }],
  });
  client.notify("initialized", {});

  let stopped = false;
  return {
    client,
    rootUri,
    document(opts) {
      return lspDocumentExtensions({ client, ...opts });
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

interface LspDocOptions {
  client: JsonRpcClient;
  uri: string;
  languageId: string;
}

function lspDocumentExtensions(opts: LspDocOptions): Extension {
  // StateField + Effect for LSP-pushed diagnostics. linter() reads from here.
  return [diagnosticsField, lifecyclePlugin(opts), linter((view) =>
    view.state.field(diagnosticsField),
  ), autocompletion({ override: [completionSource(opts)] })];
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

function lifecyclePlugin(opts: LspDocOptions) {
  return ViewPlugin.define((view: EditorView) => {
    let version = 1;
    let debounce: ReturnType<typeof setTimeout> | undefined;

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
        if (p?.uri !== opts.uri) return;
        const cmDiags = (p.diagnostics ?? [])
          .map((d) => lspToCmDiagnostic(d, view))
          .filter((d): d is Diagnostic => d !== null);
        view.dispatch({ effects: setLspDiagnostics.of(cmDiags) });
      },
    );

    return {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;
        if (debounce) clearTimeout(debounce);
        debounce = setTimeout(() => {
          opts.client.notify("textDocument/didChange", {
            textDocument: { uri: opts.uri, version: version++ },
            // Full-content sync — keeps the wire shape simple. Texlab and
            // friends accept this even when they advertise incremental sync.
            contentChanges: [{ text: update.state.doc.toString() }],
          });
        }, 200);
      },
      destroy() {
        if (debounce) clearTimeout(debounce);
        unsubDiag();
        opts.client.notify("textDocument/didClose", {
          textDocument: { uri: opts.uri },
        });
      },
    };
  });
}

// ---- Diagnostic conversion ------------------------------------------------

interface LspPosition {
  line: number;
  character: number;
}

interface LspRange {
  start: LspPosition;
  end: LspPosition;
}

interface LspDiagnostic {
  range: LspRange;
  severity?: 1 | 2 | 3 | 4; // Error | Warning | Information | Hint
  message: string;
  source?: string;
  code?: string | number;
}

function lspToCmDiagnostic(d: LspDiagnostic, view: EditorView): Diagnostic | null {
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

function lspPosToOffset(pos: LspPosition, view: EditorView): number | null {
  const doc = view.state.doc;
  if (pos.line >= doc.lines) return doc.length;
  const line = doc.line(pos.line + 1); // CM6 lines are 1-based
  return Math.min(line.from + pos.character, line.to);
}

function cmOffsetToLspPos(offset: number, view: EditorView): LspPosition {
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

function completionSource(opts: LspDocOptions) {
  return async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    if (!ctx.view) return null;
    const pos = cmOffsetToLspPos(ctx.pos, ctx.view);
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

function kindToType(kind?: number): string | undefined {
  // LSP CompletionItemKind subset — only the ones lucide-solid... wait,
  // CodeMirror "type" is a free-form string that becomes an icon class.
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
  if (/^[a-zA-Z]:/.test(normalized)) {
    return `file:///${normalized}`;
  }
  return `file://${normalized}`;
}
