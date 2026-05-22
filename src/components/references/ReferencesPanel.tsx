import { Plus, Quote, RefreshCw, Search } from "lucide-solid";
import type { Component } from "solid-js";
import { createMemo, createResource, createSignal, For, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import { citationProviders } from "~/integrations/references/registry";
import type { Citation } from "~/integrations/types";
import { insertAtCursor } from "~/stores/editor-view-store";
import { project } from "~/stores/editor-store";

import { DoiLookupDialog } from "./DoiLookupDialog";

/**
 * Sidebar tab listing references from every active provider. Click a row
 * to insert `\cite{key}` (LaTeX) or `@key` (Typst) at the current cursor.
 *
 * "Add from DOI/arXiv" opens the DoiLookupDialog, which appends to the
 * project-local `.bib` and re-runs the aggregator.
 */
export const ReferencesPanel: Component = () => {
  const [query, setQuery] = createSignal("");
  const [doiOpen, setDoiOpen] = createSignal(false);
  const [refreshTick, setRefreshTick] = createSignal(0);

  const [results] = createResource(
    () => [query(), citationProviders(), refreshTick()] as const,
    async ([q, providers]) => {
      const collected: Citation[] = [];
      for (const provider of providers) {
        try {
          const items = await provider.searchLibrary(q);
          collected.push(...items);
        } catch {
          // Surface failures via the per-provider status badge; one bad
          // provider doesn't bomb the whole panel.
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

  const providerStatus = createMemo(() => citationProviders().length);

  return (
    <div class="flex h-full flex-col">
      <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-2.5 py-2">
        <div class="glass-inset flex h-7 flex-1 items-center gap-1.5 rounded-md px-2.5">
          <Search class="ui-icon-sm text-fg-3" />
          <input
            type="search"
            placeholder="Search references…"
            value={query()}
            onInput={(e) => setQuery(e.currentTarget.value)}
            class="h-full flex-1 bg-transparent text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-3 outline-none"
          />
        </div>
        <Button
          variant="ghost"
          size="sm"
          aria-label="Refresh library"
          onClick={handleRefresh}
          disabled={providerStatus() === 0}
        >
          <RefreshCw class="ui-icon-sm" />
        </Button>
      </div>

      <div class="flex-1 overflow-auto scroll">
        <Show
          when={providerStatus() > 0}
          fallback={
            <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
              <Quote class="mx-auto mb-2 ui-icon-menu text-fg-3/60" />
              <div class="text-fg-2">No reference providers configured.</div>
              <div class="mt-1">
                Connect Zotero, Mendeley, or JabRef in Settings → Integrations to start.
              </div>
            </div>
          }
        >
          <Show
            when={results()?.length}
            fallback={
              <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
                {query().trim() ? "No matches." : "Type to search your library."}
              </div>
            }
          >
            <For each={results() ?? []}>
              {(citation) => (
                <button
                  type="button"
                  onClick={() => handleInsert(citation)}
                  class="lift flex w-full flex-col items-start gap-0.5 border-b border-glass-stroke px-3 py-2 text-left hover:bg-[var(--color-control-fill)]"
                >
                  <div class="flex w-full items-center gap-2">
                    <span class="mono truncate text-[length:var(--ui-font-xs)] text-[var(--color-accent-1)]">
                      {citation.key}
                    </span>
                    <Show when={citation.year}>
                      <span class="ml-auto text-[length:var(--ui-font-xs)] text-fg-3">
                        {citation.year}
                      </span>
                    </Show>
                  </div>
                  <div class="line-clamp-2 text-[length:var(--ui-font-sm)] text-fg-1">
                    {citation.title}
                  </div>
                  <Show when={citation.authors.length > 0}>
                    <div class="truncate text-[length:var(--ui-font-xs)] text-fg-3">
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
          Add from DOI or arXiv
        </Button>
      </div>

      <DoiLookupDialog
        open={doiOpen()}
        onOpenChange={setDoiOpen}
        onAdded={() => setRefreshTick((t) => t + 1)}
      />
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
