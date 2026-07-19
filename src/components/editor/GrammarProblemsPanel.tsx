/**
 * Grammarly-style Problems panel for Harper grammar diagnostics (per
 * `design_files/design_samples/harper.png`). Shared by both Logs surfaces —
 * the bottom `LogsDrawer` and the in-preview `LogsView` — via the Grammar tab.
 *
 * Header: total count + per-family dot+count chips that toggle a family filter.
 * Body: one expandable card per issue (family dot + humanized kind + truncated
 * message; chevron reveals the full message, suggestion chips, Ignore, and —
 * for spelling — Add to dictionary). Clicking a card jumps the editor to the
 * issue via `requestGotoSource`.
 *
 * Kind → family colours come from the single source `src/lib/grammar/kinds.ts`.
 * Suggestion apply / Add-to-dictionary act on the live CodeMirror view and are
 * therefore enabled only when the diagnostic's file is the active editor file;
 * Ignore is app-global and always available. Every mutating action re-runs the
 * active view's lint so the panel and squiggles converge.
 */

import { forceLinting, forEachDiagnostic } from "@codemirror/lint";
import type { EditorView } from "@codemirror/view";
import { ChevronDown } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";

import * as ipc from "~/ipc";
import { lineColToPos, type GrammarCmDiagnostic } from "~/lib/grammar/cm6";
import {
  GRAMMAR_FAMILIES,
  GRAMMAR_FAMILY_META,
  familyForKind,
  humanizeKind,
  type GrammarFamily,
} from "~/lib/grammar/kinds";
import { activeFile, requestGotoSource } from "~/stores/editor-store";
import { getActiveEditorView } from "~/stores/editor-view-store";
import { grammarDiagnostics } from "~/stores/grammar-store";
import { integrationsSettings } from "~/stores/settings-store";

interface GrammarIssue {
  id: string;
  file: string;
  family: GrammarFamily;
  diag: ipc.GrammarDiagnostic;
}

function collectIssues(): GrammarIssue[] {
  const out: GrammarIssue[] = [];
  for (const entry of grammarDiagnostics().values()) {
    entry.items.forEach((diag, i) => {
      out.push({
        id: `${entry.file}:${diag.line}:${diag.col}:${diag.contextHash}:${i}`,
        file: entry.file,
        family: familyForKind(diag.kind),
        diag,
      });
    });
  }
  out.sort(
    (a, b) => a.file.localeCompare(b.file) || a.diag.line - b.diag.line,
  );
  return out;
}

function refreshActiveLint(): void {
  const view = getActiveEditorView();
  if (view) forceLinting(view);
}

/**
 * Resolve the panel's (stale) diagnostic to a live, buffer-mapped range from the
 * active `@codemirror/lint` set — the same positions the in-tooltip actions use.
 * Matches on `contextHash`; when several live lints share a hash, it picks the
 * one nearest the stale line/col estimate. Returns null when the lint is gone
 * (e.g. the buffer changed and it no longer fires), so callers can bail + relint.
 */
function findLiveRange(
  view: EditorView,
  diag: ipc.GrammarDiagnostic,
): { from: number; to: number } | null {
  const estimate = lineColToPos(view, diag.line, diag.col);
  const holder: { best: { from: number; to: number; dist: number } | null } = {
    best: null,
  };
  forEachDiagnostic(view.state, (d, from, to) => {
    if ((d as Partial<GrammarCmDiagnostic>).contextHash !== diag.contextHash)
      return;
    const dist = Math.abs(from - estimate);
    if (!holder.best || dist < holder.best.dist)
      holder.best = { from, to, dist };
  });
  const best = holder.best;
  return best ? { from: best.from, to: best.to } : null;
}

export const GrammarProblemsPanel: Component = () => {
  const grammarEnabled = () => integrationsSettings().grammar.enabled;
  const issues = createMemo(collectIssues);

  const [activeFilters, setActiveFilters] = createSignal<Set<GrammarFamily>>(
    new Set(),
  );
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set());

  const counts = createMemo(() => {
    const c: Record<GrammarFamily, number> = {
      spelling: 0,
      grammar: 0,
      style: 0,
      misc: 0,
    };
    for (const issue of issues()) c[issue.family] += 1;
    return c;
  });

  const visible = createMemo(() => {
    const filters = activeFilters();
    if (filters.size === 0) return issues();
    return issues().filter((issue) => filters.has(issue.family));
  });

  const toggleFilter = (family: GrammarFamily) => {
    setActiveFilters((prev) => {
      const next = new Set(prev);
      if (next.has(family)) next.delete(family);
      else next.add(family);
      return next;
    });
  };

  const toggleExpanded = (id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  return (
    <Show
      when={issues().length > 0}
      fallback={
        <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
          <div class="text-base font-semibold text-fg-1">No grammar issues</div>
          <div class="max-w-[380px] text-xs leading-relaxed text-fg-3">
            {grammarEnabled()
              ? "Diagnostics appear for files you've opened with grammar on."
              : "Grammar lint is off — enable it in Settings → Integrations → Grammar."}
          </div>
        </div>
      }
    >
      <div class="flex h-full flex-col">
        {/* Header — total + per-family filter chips */}
        <div class="flex flex-shrink-0 flex-wrap items-center gap-1.5 border-b border-glass-stroke px-3 py-2">
          <span class="mr-1 text-sm font-semibold text-fg-1">
            {issues().length} problem{issues().length === 1 ? "" : "s"}
          </span>
          <For each={GRAMMAR_FAMILIES}>
            {(family) => {
              const meta = GRAMMAR_FAMILY_META[family];
              const active = () => activeFilters().has(family);
              return (
                <Show when={counts()[family] > 0}>
                  <button
                    type="button"
                    aria-pressed={active()}
                    onClick={() => toggleFilter(family)}
                    class="lift flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium"
                    style={
                      active()
                        ? {
                            background: `color-mix(in srgb, ${meta.cssVar} 16%, transparent)`,
                            border: `1px solid color-mix(in srgb, ${meta.cssVar} 55%, transparent)`,
                            color: "var(--color-fg-1)",
                          }
                        : {
                            border: "1px solid var(--color-glass-stroke)",
                            color: "var(--color-fg-2)",
                          }
                    }
                  >
                    <span
                      class="h-1.5 w-1.5 rounded-full"
                      style={{ background: meta.cssVar }}
                    />
                    {meta.label}
                    <span class="mono text-fg-3">{counts()[family]}</span>
                  </button>
                </Show>
              );
            }}
          </For>
        </div>

        {/* Body — one card per issue */}
        <div class="min-h-0 flex-1 space-y-2 overflow-auto p-3 scroll">
          <For each={visible()}>
            {(issue) => (
              <IssueRow
                issue={issue}
                open={expanded().has(issue.id)}
                onToggle={() => toggleExpanded(issue.id)}
              />
            )}
          </For>
        </div>
      </div>
    </Show>
  );
};

const IssueRow: Component<{
  issue: GrammarIssue;
  open: boolean;
  onToggle: () => void;
}> = (props) => {
  const meta = () => GRAMMAR_FAMILY_META[props.issue.family];
  const diag = () => props.issue.diag;
  const isActiveFile = () => activeFile()?.relPath === props.issue.file;
  const suggestions = () => diag().replacements.filter((r) => r.length > 0).slice(0, 3);

  const jump = () =>
    requestGotoSource(props.issue.file, diag().line);

  const applySuggestion = (replacement: string) => {
    const view = getActiveEditorView();
    if (!view || !isActiveFile()) return;
    const range = findLiveRange(view, diag());
    if (!range) {
      forceLinting(view);
      return;
    }
    view.dispatch({
      changes: { from: range.from, to: range.to, insert: replacement },
    });
    forceLinting(view);
  };

  const ignore = () => {
    void ipc
      .grammarIgnoreLint(diag().contextHash)
      .then(refreshActiveLint)
      .catch(() => {});
  };

  const addToDictionary = () => {
    const view = getActiveEditorView();
    if (!view || !isActiveFile()) return;
    const range = findLiveRange(view, diag());
    if (!range) {
      forceLinting(view);
      return;
    }
    const word = view.state.sliceDoc(range.from, range.to).trim();
    if (!word) return;
    void ipc
      .grammarAddWord(word)
      .then(() => forceLinting(view))
      .catch(() => {});
  };

  return (
    <div
      class="rounded-lg"
      style={{
        background: "var(--color-control-fill)",
        border: "1px solid var(--color-control-stroke)",
      }}
    >
      {/* Header row — click jumps to source; chevron toggles detail. */}
      <div class="flex items-center gap-2 px-3 py-2">
        <button
          type="button"
          onClick={jump}
          title="Jump to source"
          class="flex min-w-0 flex-1 items-center gap-2 text-left"
        >
          <span
            class="h-2 w-2 flex-shrink-0 rounded-full"
            style={{ background: meta().cssVar }}
          />
          <span class="flex-shrink-0 text-sm font-semibold text-fg-1">
            {humanizeKind(diag().kind)}
          </span>
          <span class="truncate text-sm text-fg-2">{diag().message}</span>
        </button>
        <span class="mono flex-shrink-0 text-xs text-fg-3">
          {props.issue.file}:{diag().line}
        </span>
        <button
          type="button"
          onClick={props.onToggle}
          aria-expanded={props.open}
          aria-label={props.open ? "Collapse" : "Expand"}
          class="lift flex h-6 w-6 flex-shrink-0 items-center justify-center rounded hover:bg-[var(--color-control-fill-hover)]"
        >
          <ChevronDown
            size={14}
            class="opacity-60 transition-transform"
            style={props.open ? { transform: "rotate(180deg)" } : undefined}
          />
        </button>
      </div>

      <Show when={props.open}>
        <div class="space-y-2 border-t border-glass-stroke px-3 py-2">
          <div class="text-sm text-fg-2">{diag().message}</div>
          <div class="flex flex-wrap items-center gap-1.5">
            <For each={suggestions()}>
              {(s) => (
                <button
                  type="button"
                  disabled={!isActiveFile()}
                  onClick={() => applySuggestion(s)}
                  title={
                    isActiveFile()
                      ? "Apply suggestion"
                      : "Open this file to apply"
                  }
                  class="lift rounded-md px-2 py-0.5 text-xs font-medium enabled:hover:bg-[var(--color-control-fill-hover)] disabled:opacity-40"
                  style={{
                    background: "var(--color-control-fill)",
                    border: "1px solid var(--color-control-stroke)",
                    color: "var(--color-fg-1)",
                  }}
                >
                  {s}
                </button>
              )}
            </For>
            <Show when={diag().kind === "Spelling"}>
              <button
                type="button"
                disabled={!isActiveFile()}
                onClick={addToDictionary}
                title={
                  isActiveFile()
                    ? "Add to dictionary"
                    : "Open this file to add the word"
                }
                class="lift rounded-md px-2 py-0.5 text-xs font-medium enabled:hover:bg-[var(--color-control-fill-hover)] disabled:opacity-40"
                style={{
                  border: "1px solid var(--color-control-stroke)",
                  color: "var(--color-fg-2)",
                }}
              >
                Add to dictionary
              </button>
            </Show>
            <button
              type="button"
              onClick={ignore}
              title="Ignore this lint everywhere"
              class="lift rounded-md px-2 py-0.5 text-xs font-medium hover:bg-[var(--color-control-fill-hover)]"
              style={{
                border: "1px solid var(--color-control-stroke)",
                color: "var(--color-fg-2)",
              }}
            >
              Ignore
            </button>
            <button
              type="button"
              onClick={jump}
              class="lift ml-auto rounded-md px-2 py-0.5 text-xs font-medium hover:bg-[var(--color-control-fill-hover)]"
              style={{
                border: "1px solid var(--color-control-stroke)",
                color: "var(--color-fg-2)",
              }}
            >
              Open file
            </button>
          </div>
        </div>
      </Show>
    </div>
  );
};
