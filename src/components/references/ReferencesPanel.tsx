import { Check, ChevronDown, Library, Plus, Quote, RefreshCw, Search } from "lucide-solid";
import type { Component } from "solid-js";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import { citationProviders } from "~/integrations/references/registry";
import type { Citation } from "~/integrations/types";
import { installDismiss } from "~/lib/dismiss";
import { insertAtCursor } from "~/stores/editor-view-store";
import { project } from "~/stores/editor-store";

import { DoiLookupDialog } from "./DoiLookupDialog";

/**
 * Sidebar tab listing references. The user first picks a **library** (a Zotero
 * personal / group library, or another provider's whole library); the choice
 * is remembered per project and only that library's citations are listed.
 * Click a row to insert `\cite{key}` (LaTeX) or `@key` (Typst) at the cursor.
 *
 * The per-project library choice is a browsing preference, persisted in
 * localStorage keyed by project root (not project.json) — it doesn't change
 * the compiled `library.bib`, which still aggregates every provider.
 */

const SELECTION_KEY = "typeward.refs-library";

const readSelection = (): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(SELECTION_KEY) ?? "{}");
  } catch {
    return {};
  }
};

const [selectionMap, setSelectionMap] = createSignal<Record<string, string>>(
  readSelection(),
);

const persistSelection = (next: Record<string, string>): void => {
  try {
    localStorage.setItem(SELECTION_KEY, JSON.stringify(next));
  } catch {
    // Storage unavailable — keep the in-memory value for the session.
  }
};

export const ReferencesPanel: Component = () => {
  const [query, setQuery] = createSignal("");
  const [doiOpen, setDoiOpen] = createSignal(false);
  const [refreshTick, setRefreshTick] = createSignal(0);

  // Available libraries across every active provider. Providers that don't
  // enumerate sub-libraries contribute a single entry named by displayName.
  const [libraryOptions] = createResource(
    () => [citationProviders(), refreshTick()] as const,
    async ([providers]) => {
      const names: string[] = [];
      for (const provider of providers) {
        try {
          const libs = provider.listLibraries
            ? await provider.listLibraries()
            : [provider.displayName];
          for (const n of libs) if (!names.includes(n)) names.push(n);
        } catch {
          // A provider that can't enumerate is simply skipped.
        }
      }
      return names;
    },
    { initialValue: [] },
  );

  const options = () => libraryOptions() ?? [];

  const selected = createMemo(() => {
    const proj = project();
    if (!proj) return null;
    const sel = selectionMap()[proj.rootPath];
    // Only honor a selection that's still a real library.
    return sel && options().includes(sel) ? sel : null;
  });

  const selectLibrary = (name: string | null) => {
    const proj = project();
    if (!proj) return;
    setSelectionMap((prev) => {
      const next = { ...prev };
      if (name) next[proj.rootPath] = name;
      else delete next[proj.rootPath];
      persistSelection(next);
      return next;
    });
  };

  // One library? Pick it automatically — no reason to make the user choose.
  createEffect(() => {
    const opts = options();
    if (project() && !selected() && opts.length === 1) selectLibrary(opts[0]);
  });

  const [results] = createResource(
    () => [query(), selected(), citationProviders(), refreshTick()] as const,
    async ([q, lib, providers]) => {
      if (!lib) return [];
      const collected: Citation[] = [];
      for (const provider of providers) {
        try {
          const items = await provider.searchLibrary(q, lib);
          for (const it of items) collected.push({ ...it, library: it.library ?? lib });
        } catch {
          // One bad provider doesn't bomb the panel.
        }
      }
      return dedupe(collected);
    },
    { initialValue: [] },
  );

  const handleInsert = (citation: Citation) => {
    const proj = project();
    if (!proj) return;
    const snippet = proj.format === "typst" ? `@${citation.key}` : `\\cite{${citation.key}}`;
    insertAtCursor(snippet);
  };

  const handleRefresh = async () => {
    const proj = project();
    if (!proj) return;
    await refreshLibraryBib(proj);
    setRefreshTick((t) => t + 1);
  };

  const hasProviders = () => citationProviders().length > 0;

  return (
    <div class="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <Show
        when={hasProviders()}
        fallback={
          <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
            <Quote class="mx-auto mb-2 ui-icon-menu text-fg-3/60" />
            <div class="text-fg-2">No reference providers configured.</div>
            <div class="mt-1">
              Connect Zotero or Mendeley in Settings → Integrations to start.
            </div>
          </div>
        }
      >
        <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-2.5 py-2">
          <LibrarySelect
            options={options()}
            selected={selected()}
            loading={libraryOptions.loading}
            onSelect={selectLibrary}
          />
          <Button
            variant="ghost"
            size="sm"
            aria-label="Refresh library"
            onClick={handleRefresh}
          >
            <RefreshCw class="ui-icon-sm" />
          </Button>
        </div>

        <Show when={selected()}>
          <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-2.5 py-2">
            <div class="glass-inset flex h-7 min-w-0 flex-1 items-center gap-1.5 rounded-md px-2.5">
              <Search class="ui-icon-sm flex-shrink-0 text-fg-3" />
              <input
                type="search"
                placeholder="Search references…"
                value={query()}
                onInput={(e) => setQuery(e.currentTarget.value)}
                class="h-full min-w-0 flex-1 bg-transparent text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-3 outline-none"
              />
            </div>
          </div>
        </Show>

        <div class="min-h-0 flex-1 overflow-auto scroll">
          <Show
            when={selected()}
            fallback={
              <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
                <Library class="mx-auto mb-2 ui-icon-menu text-fg-3/60" />
                <div class="text-fg-2">
                  {options().length === 0
                    ? "No libraries found."
                    : "Choose a library to view its references."}
                </div>
                <Show when={options().length === 0}>
                  <div class="mt-1">
                    Make sure Zotero is running with its local API enabled.
                  </div>
                </Show>
              </div>
            }
          >
            <Show
              when={results().length}
              fallback={
                <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
                  {query().trim() ? "No matches." : "This library is empty."}
                </div>
              }
            >
              <For each={results()}>
                {(citation) => (
                  <button
                    type="button"
                    onClick={() => handleInsert(citation)}
                    class="lift flex w-full min-w-0 flex-col items-start gap-0.5 border-b border-glass-stroke px-3 py-2 text-left hover:bg-[var(--color-control-fill)]"
                  >
                    <div class="flex w-full min-w-0 items-center gap-2">
                      <span class="mono truncate text-[length:var(--ui-font-xs)] text-[var(--color-accent-1)]">
                        {citation.key}
                      </span>
                      <Show when={citation.year}>
                        <span class="ml-auto flex-shrink-0 text-[length:var(--ui-font-xs)] text-fg-3">
                          {citation.year}
                        </span>
                      </Show>
                    </div>
                    <div class="line-clamp-2 text-[length:var(--ui-font-sm)] text-fg-1">
                      {citation.title}
                    </div>
                    <Show when={citation.authors.length > 0}>
                      <div class="w-full truncate text-[length:var(--ui-font-xs)] text-fg-3">
                        {citation.authors.slice(0, 3).join(", ")}
                        {citation.authors.length > 3 ? ` +${citation.authors.length - 3}` : ""}
                      </div>
                    </Show>
                  </button>
                )}
              </For>
            </Show>
          </Show>
        </div>

        <div class="flex-shrink-0 border-t border-glass-stroke px-2.5 py-2">
          <Button
            variant="secondary"
            size="sm"
            class="w-full"
            leadingIcon={<Plus class="ui-icon-sm" />}
            onClick={() => setDoiOpen(true)}
          >
            Add from DOI
          </Button>
        </div>
      </Show>

      <DoiLookupDialog
        open={doiOpen()}
        onOpenChange={setDoiOpen}
        onAdded={() => setRefreshTick((t) => t + 1)}
      />
    </div>
  );
};

const LibrarySelect: Component<{
  options: string[];
  selected: string | null;
  loading: boolean;
  onSelect: (name: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  const label = () =>
    props.selected ?? (props.loading ? "Loading libraries…" : "Select a library…");

  return (
    <div ref={rootRef} class="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={props.options.length === 0}
        class="glass-inset flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left disabled:opacity-60"
      >
        <Library class="ui-icon-sm flex-shrink-0 text-fg-3" />
        <span
          class="min-w-0 flex-1 truncate text-[length:var(--ui-font-sm)]"
          classList={{ "text-fg-1": !!props.selected, "text-fg-3": !props.selected }}
        >
          {label()}
        </span>
        <ChevronDown class="ui-icon-sm flex-shrink-0 text-fg-3" />
      </button>
      <Show when={open() && props.options.length > 0}>
        <div
          class="glass absolute left-0 right-0 top-full z-40 mt-1 max-h-[260px] overflow-auto scroll rounded-lg"
          style={{ padding: "4px", background: "var(--color-popover-bg)" }}
        >
          <For each={props.options}>
            {(name) => {
              const active = () => props.selected === name;
              return (
                <button
                  type="button"
                  onClick={() => {
                    props.onSelect(name);
                    setOpen(false);
                  }}
                  class={`lift flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[length:var(--ui-font-sm)] ${
                    active()
                      ? "bg-[var(--color-control-fill-hover)] text-fg-1"
                      : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                  }`}
                >
                  <span class="min-w-0 flex-1 truncate">{name}</span>
                  <Show when={active()}>
                    <Check class="ui-icon-sm flex-shrink-0 text-[var(--color-accent-1)]" />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

function dedupe(citations: Citation[]): Citation[] {
  const seen = new Set<string>();
  const out: Citation[] = [];
  for (const c of citations) {
    if (seen.has(c.key)) continue;
    seen.add(c.key);
    out.push(c);
  }
  return out;
}
