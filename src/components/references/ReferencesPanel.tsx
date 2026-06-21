import {
  BookMarked,
  Check,
  ChevronDown,
  Folder,
  Plus,
  RefreshCw,
  Search,
} from "lucide-solid";
import type { Component } from "solid-js";
import { createEffect, createMemo, createResource, createSignal, For, Show } from "solid-js";
import { Dynamic } from "solid-js/web";

import { Button } from "~/components/primitives/Button";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import { citationProviders } from "~/integrations/references/registry";
import type { Citation, LibraryNode } from "~/integrations/types";
import { installDismiss } from "~/lib/dismiss";
import { insertAtCursor } from "~/stores/editor-view-store";
import { project } from "~/stores/editor-store";

import { DoiLookupDialog } from "./DoiLookupDialog";

/**
 * Sidebar tab listing references. Two selectors: the reference **manager**
 * (provider — book icon) and a single **library / folder** tree (folder icon)
 * showing that manager's libraries with their collections/subfolders nested.
 *
 * Only the chosen manager is queried. Libraries load fast (no collection
 * discovery); a manager's folders merge into the tree as they arrive, so the
 * library list isn't blocked on folder lookups. The manager step is hidden when
 * only one manager is reachable.
 *
 * Choices persist per project in localStorage (the node choice keyed per
 * manager). They're browsing preferences only — `library.bib` still aggregates
 * every provider's full catalog so any inserted `\cite{key}` resolves.
 */

const PROVIDER_KEY = "typeward.refs-provider";
const SELECTION_KEY = "typeward.refs-library";

const readMap = (key: string): Record<string, string> => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? "{}");
  } catch {
    return {};
  }
};

const persist = (key: string, next: Record<string, string>): void => {
  try {
    localStorage.setItem(key, JSON.stringify(next));
  } catch {
    // Storage unavailable — keep the in-memory value for the session.
  }
};

const [providerMap, setProviderMap] = createSignal<Record<string, string>>(readMap(PROVIDER_KEY));
const [selectionMap, setSelectionMap] = createSignal<Record<string, string>>(readMap(SELECTION_KEY));

/** Order a flat node list into a tree (parents before children); cycle-safe. */
function orderedTree(nodes: LibraryNode[]): Array<{ node: LibraryNode; depth: number }> {
  const ids = new Set(nodes.map((n) => n.id));
  const byParent = new Map<string | undefined, LibraryNode[]>();
  for (const n of nodes) {
    const parent = n.parentId && ids.has(n.parentId) ? n.parentId : undefined;
    const siblings = byParent.get(parent) ?? [];
    siblings.push(n);
    byParent.set(parent, siblings);
  }
  const out: Array<{ node: LibraryNode; depth: number }> = [];
  const visited = new Set<string>();
  const walk = (parent: string | undefined, depth: number) => {
    const siblings = [...(byParent.get(parent) ?? [])].sort((a, b) =>
      a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
    );
    for (const n of siblings) {
      if (visited.has(n.id)) continue; // guard against malformed parent cycles
      visited.add(n.id);
      out.push({ node: n, depth });
      walk(n.id, depth + 1);
    }
  };
  walk(undefined, 0);
  for (const n of nodes) {
    if (!visited.has(n.id)) {
      visited.add(n.id);
      out.push({ node: n, depth: 0 }); // surface cycle-stranded nodes, don't drop
    }
  }
  return out;
}

/** Full "Library / Folder / Subfolder" path for a node, for the picker tooltip. */
function nodePath(nodeId: string | null, nodes: LibraryNode[]): string | undefined {
  if (!nodeId) return undefined;
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const parts: string[] = [];
  const seen = new Set<string>();
  let cur = byId.get(nodeId);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.length ? parts.join(" / ") : undefined;
}

export const ReferencesPanel: Component = () => {
  const [query, setQuery] = createSignal("");
  const [doiOpen, setDoiOpen] = createSignal(false);
  const [refreshTick, setRefreshTick] = createSignal(0);

  const providers = () => citationProviders();
  const findProvider = (id: string | null) =>
    citationProviders().find((p) => p.id === id) ?? null;

  // ----- Reachability: only offer managers whose status() is ready -----
  const [availableRes] = createResource(
    () => [citationProviders(), refreshTick()] as const,
    async ([provs]) => {
      const ready = await Promise.all(
        provs.map((p) =>
          p
            .status()
            .then((s) => (s === "ready" ? p.id : null))
            .catch(() => null),
        ),
      );
      const readyIds = new Set(ready.filter((id): id is string => id !== null));
      return provs.filter((p) => readyIds.has(p.id)).map((p) => ({ id: p.id, name: p.displayName }));
    },
    { initialValue: [] },
  );
  const sources = () => availableRes() ?? [];

  // ----- Manager (provider) -----
  const selectedProviderId = createMemo(() => {
    const proj = project();
    if (!proj) return null;
    const sel = providerMap()[proj.rootPath];
    return sel && providers().some((p) => p.id === sel) ? sel : null;
  });
  const selectedProviderName = () => findProvider(selectedProviderId())?.displayName ?? "";

  const selectProvider = (id: string) => {
    const proj = project();
    if (!proj) return;
    setProviderMap((prev) => {
      const next = { ...prev, [proj.rootPath]: id };
      persist(PROVIDER_KEY, next);
      return next;
    });
  };

  createEffect(() => {
    if (!project() || selectedProviderId()) return;
    const s = sources();
    if (s.length === 1) selectProvider(s[0].id);
  });

  // ----- Libraries (fast) + their collections (merged in as they load) -----
  // Both stamped with the provider id so a switch never shows the previous
  // provider's entries while the resource refetches.
  const [librariesRes] = createResource(
    () => [selectedProviderId(), refreshTick()] as const,
    async ([pid]): Promise<{ pid: string | null; libs: LibraryNode[] }> => {
      const provider = findProvider(pid);
      if (!pid || !provider) return { pid, libs: [] };
      try {
        const libs = provider.listLibraryNodes
          ? await provider.listLibraryNodes()
          : [{ id: provider.displayName, name: provider.displayName, kind: "library" as const }];
        return { pid, libs };
      } catch {
        return { pid, libs: [] };
      }
    },
    { initialValue: { pid: null, libs: [] } },
  );

  const [collectionsRes] = createResource(
    () => [selectedProviderId(), librariesRes(), refreshTick()] as const,
    async ([pid, libsRes]): Promise<{ pid: string | null; cols: LibraryNode[] }> => {
      const provider = findProvider(pid);
      if (!pid || !provider?.listCollections || libsRes.pid !== pid) return { pid, cols: [] };
      const lists = await Promise.all(
        libsRes.libs.map((lib) =>
          provider
            .listCollections!(lib.id)
            // Re-root a library's top-level collections under that library so the
            // combined tree nests them (listCollections leaves them parentless).
            .then((cs) => cs.map((c) => ({ ...c, parentId: c.parentId ?? lib.id })))
            .catch(() => [] as LibraryNode[]),
        ),
      );
      return { pid, cols: lists.flat() };
    },
    { initialValue: { pid: null, cols: [] } },
  );

  const nodes = () => {
    const pid = selectedProviderId();
    const lr = librariesRes();
    const cr = collectionsRes();
    const libs = lr.pid === pid ? lr.libs : [];
    const cols = cr.pid === pid ? cr.cols : [];
    return [...libs, ...cols];
  };

  // ----- Selected node (library or collection) — the browse target -----
  const nodeKey = () => {
    const proj = project();
    const pid = selectedProviderId();
    return proj && pid ? `${proj.rootPath}::${pid}` : null;
  };
  const selectedNodeId = createMemo(() => {
    const k = nodeKey();
    if (!k) return null;
    const sel = selectionMap()[k];
    return sel && nodes().some((n) => n.id === sel) ? sel : null;
  });
  const selectedNode = () => nodes().find((n) => n.id === selectedNodeId()) ?? null;

  const selectNode = (id: string) => {
    const k = nodeKey();
    if (!k) return;
    setSelectionMap((prev) => {
      const next = { ...prev, [k]: id };
      persist(SELECTION_KEY, next);
      return next;
    });
  };

  // Auto-select the first library. If a selection was persisted (possibly a
  // folder), wait for collections so it can validate instead of being clobbered.
  createEffect(() => {
    if (!selectedProviderId() || selectedNodeId()) return;
    const k = nodeKey();
    const hasPersisted = k ? selectionMap()[k] !== undefined : false;
    if (hasPersisted && collectionsRes.loading) return;
    const roots = nodes().filter((n) => !n.parentId && n.kind === "library");
    if (roots.length) selectNode(roots[0].id);
  });

  // ----- Results: query the selected manager's chosen node only -----
  const [results] = createResource(
    () => [query(), selectedNodeId(), selectedProviderId(), refreshTick()] as const,
    async ([q, nodeId, pid]) => {
      const provider = findProvider(pid);
      if (!nodeId || !provider) return [];
      try {
        return dedupe(await provider.searchLibrary(q, nodeId));
      } catch {
        return [];
      }
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
    for (const p of citationProviders()) p.invalidate?.();
    await refreshLibraryBib(proj);
    setRefreshTick((t) => t + 1);
  };

  const hasProviders = () => providers().length > 0;
  // Synchronous (registered count) so the manager control appears with the tree.
  const showSourceStep = () => providers().length > 1;

  return (
    <div class="flex h-full w-full min-w-0 flex-col overflow-hidden">
      <Show
        when={hasProviders()}
        fallback={
          <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
            <BookMarked class="mx-auto mb-2 ui-icon-menu text-fg-3/60" />
            <div class="text-fg-2">No reference providers configured.</div>
            <div class="mt-1">
              Connect Zotero or Mendeley in Settings → Integrations to start.
            </div>
          </div>
        }
      >
        {/* Several reachable managers and none chosen yet → full manager selector. */}
        <Show when={showSourceStep() && !selectedProviderId()}>
          <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-2.5 py-2">
            <FlatSelect
              items={sources()}
              selectedId={null}
              icon={BookMarked}
              loading={availableRes.loading}
              placeholder="Select a reference manager…"
              onSelect={selectProvider}
            />
          </div>
        </Show>

        {/* Manager (book icon) + the library/folder tree (folder icon). */}
        <Show when={selectedProviderId()}>
          <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-2.5 py-2">
            <Show when={showSourceStep()}>
              <FlatSelect
                compact
                items={sources()}
                selectedId={selectedProviderId()}
                selectedName={selectedProviderName()}
                icon={BookMarked}
                onSelect={selectProvider}
              />
            </Show>
            <TreeSelect
              nodes={nodes()}
              selected={selectedNode()}
              loading={librariesRes.loading}
              disabled={!selectedProviderId()}
              onSelect={selectNode}
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
        </Show>

        <Show when={selectedNodeId()}>
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
            when={selectedNodeId()}
            fallback={
              <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
                <Folder class="mx-auto mb-2 ui-icon-menu text-fg-3/60" />
                <Show
                  when={selectedProviderId()}
                  fallback={
                    <Show
                      when={!availableRes.loading}
                      fallback={<div class="text-fg-2">Checking reference managers…</div>}
                    >
                      <Show
                        when={sources().length > 0}
                        fallback={
                          <>
                            <div class="text-fg-2">No reference managers are reachable.</div>
                            <div class="mt-1">
                              Make sure Zotero is running, or check Settings → Integrations.
                            </div>
                          </>
                        }
                      >
                        <div class="text-fg-2">Choose a reference manager above.</div>
                      </Show>
                    </Show>
                  }
                >
                  <Show
                    when={!librariesRes.loading && !collectionsRes.loading}
                    fallback={
                      <div class="text-fg-2">
                        {librariesRes.loading ? "Loading libraries…" : "Loading folders…"}
                      </div>
                    }
                  >
                    <div class="text-fg-2">No libraries found.</div>
                    <div class="mt-1">
                      Make sure the reference manager is reachable and try Refresh.
                    </div>
                  </Show>
                </Show>
              </div>
            }
          >
            <Show
              when={results().length}
              fallback={
                <div class="px-4 py-6 text-center text-[length:var(--ui-font-sm)] text-fg-3">
                  {results.loading
                    ? "Loading references…"
                    : query().trim()
                      ? "No matches."
                      : "This library is empty."}
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

/** Flat dropdown for the manager step. Compact = icon-only once chosen. */
const FlatSelect: Component<{
  items: Array<{ id: string; name: string }>;
  selectedId: string | null;
  selectedName?: string;
  icon: Component<{ class?: string }>;
  compact?: boolean;
  loading?: boolean;
  placeholder?: string;
  onSelect: (id: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  const label = () => {
    const sel = props.items.find((p) => p.id === props.selectedId)?.name ?? props.selectedName;
    if (sel) return sel;
    if (props.items.length === 0) return props.loading ? "Loading…" : "Nothing available";
    return props.placeholder ?? "Select…";
  };

  return (
    <div ref={rootRef} class={`relative ${props.compact ? "flex-shrink-0" : "min-w-0 flex-1"}`}>
      <Show
        when={props.compact}
        fallback={
          <button
            type="button"
            onClick={() => setOpen((v) => !v)}
            disabled={props.items.length === 0 && !props.loading}
            title={props.selectedName}
            class="glass-inset flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left disabled:opacity-60"
          >
            <Dynamic component={props.icon} class="ui-icon-sm flex-shrink-0 text-fg-3" />
            <span
              class="min-w-0 flex-1 truncate text-[length:var(--ui-font-sm)]"
              classList={{ "text-fg-1": !!props.selectedId, "text-fg-3": !props.selectedId }}
            >
              {label()}
            </span>
            <ChevronDown class="ui-icon-sm flex-shrink-0 text-fg-3" />
          </button>
        }
      >
        <button
          type="button"
          onClick={() => setOpen((v) => !v)}
          title={props.selectedName}
          class="glass-inset flex h-7 flex-shrink-0 items-center gap-0.5 rounded-md px-1.5"
        >
          <Dynamic component={props.icon} class="ui-icon-sm flex-shrink-0 text-fg-3" />
          <ChevronDown class="ui-icon-sm flex-shrink-0 text-fg-3" />
        </button>
      </Show>
      <Show when={open() && props.items.length > 0}>
        <div
          class={`glass absolute top-full z-40 mt-1 max-h-[280px] overflow-auto scroll rounded-lg ${
            props.compact ? "left-0" : "left-0 right-0"
          }`}
          style={{
            padding: "4px",
            background: "var(--color-popover-bg)",
            ...(props.compact ? { "min-width": "220px" } : {}),
          }}
        >
          <For each={props.items}>
            {(item) => {
              const active = () => props.selectedId === item.id;
              return (
                <button
                  type="button"
                  onClick={() => {
                    props.onSelect(item.id);
                    setOpen(false);
                  }}
                  class={`lift flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-left text-[length:var(--ui-font-sm)] ${
                    active()
                      ? "bg-[var(--color-control-fill-hover)] text-fg-1"
                      : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                  }`}
                >
                  <Dynamic component={props.icon} class="ui-icon-sm flex-shrink-0 text-fg-3" />
                  <span class="min-w-0 flex-1 truncate">{item.name}</span>
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

/** The combined library / folder / subfolder tree (folder icon throughout). */
const TreeSelect: Component<{
  nodes: LibraryNode[];
  selected: LibraryNode | null;
  loading: boolean;
  disabled?: boolean;
  onSelect: (id: string) => void;
}> = (props) => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  const ordered = createMemo(() => orderedTree(props.nodes));
  const label = () =>
    props.selected?.name ??
    (props.disabled ? "Choose a manager first" : props.loading ? "Loading libraries…" : "Select a library…");

  return (
    <div ref={rootRef} class="relative min-w-0 flex-1">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={props.disabled || props.nodes.length === 0}
        title={nodePath(props.selected?.id ?? null, props.nodes)}
        class="glass-inset flex h-7 w-full min-w-0 items-center gap-1.5 rounded-md px-2.5 text-left disabled:opacity-60"
      >
        <Folder class="ui-icon-sm flex-shrink-0 text-fg-3" />
        <span
          class="min-w-0 flex-1 truncate text-[length:var(--ui-font-sm)]"
          classList={{ "text-fg-1": !!props.selected, "text-fg-3": !props.selected }}
        >
          {label()}
        </span>
        <ChevronDown class="ui-icon-sm flex-shrink-0 text-fg-3" />
      </button>
      <Show when={open() && props.nodes.length > 0}>
        <div
          class="glass absolute left-0 right-0 top-full z-40 mt-1 max-h-[280px] overflow-auto scroll rounded-lg"
          style={{ padding: "4px", background: "var(--color-popover-bg)" }}
        >
          <For each={ordered()}>
            {(row) => {
              const active = () => props.selected?.id === row.node.id;
              return (
                <button
                  type="button"
                  onClick={() => {
                    props.onSelect(row.node.id);
                    setOpen(false);
                  }}
                  class={`lift flex w-full items-center gap-2 rounded-md py-1.5 pr-2.5 text-left text-[length:var(--ui-font-sm)] ${
                    active()
                      ? "bg-[var(--color-control-fill-hover)] text-fg-1"
                      : "text-fg-2 hover:bg-[var(--color-control-fill)]"
                  }`}
                  style={{ "padding-left": `${10 + row.depth * 14}px` }}
                >
                  <Folder class="ui-icon-sm flex-shrink-0 text-fg-3" />
                  <span class="min-w-0 flex-1 truncate">{row.node.name}</span>
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
