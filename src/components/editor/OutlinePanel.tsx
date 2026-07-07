import { ChevronDown, ChevronRight, ChevronUp, ListTree } from "lucide-solid";
import type { Component } from "solid-js";
import {
  For,
  Show,
  createEffect,
  createMemo,
  createResource,
  createSignal,
  onCleanup,
} from "solid-js";
import { languageForFile, lspLanguageForFile } from "~/adapters/languages";
import { pathToFileUri } from "~/lib/lsp/cm6";
import { requestDocumentSymbols } from "~/lib/lsp/symbols";
import {
  type OutlineItem,
  type OutlineLanguage,
  parseOutline,
} from "~/lib/outline/parse";
import { activeFile } from "~/stores/editor-store";
import { cursorLine, setCursorLine } from "~/stores/editor-view-store";
import { findSession, sessions } from "~/stores/lsp-store";

function outlineLangFor(relPath: string): OutlineLanguage | null {
  const lang = languageForFile(relPath);
  return lang === "latex" || lang === "typst" || lang === "markdown" ? lang : null;
}

function flatten(items: OutlineItem[], out: OutlineItem[] = []): OutlineItem[] {
  for (const it of items) {
    out.push(it);
    flatten(it.children, out);
  }
  return out;
}

const nodeKey = (it: { line: number; title: string }): string =>
  `${it.line}:${it.title}`;

export const OutlinePanel: Component<{
  collapsed: boolean;
  onToggle: () => void;
}> = (props) => {
  // Debounced content so a documentSymbol request / reparse doesn't fire per
  // keystroke; a file-identity change bypasses the debounce.
  const [debounced, setDebounced] = createSignal("");
  let timer: ReturnType<typeof setTimeout> | undefined;
  let lastPath: string | undefined;
  createEffect(() => {
    const f = activeFile();
    const content = f?.content ?? "";
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    if (f?.path !== lastPath) {
      lastPath = f?.path;
      setDebounced(content);
      return;
    }
    timer = setTimeout(() => setDebounced(content), 500);
  });
  onCleanup(() => {
    if (timer !== undefined) clearTimeout(timer);
  });

  const [outlineRes] = createResource(
    () => [activeFile()?.path, debounced(), sessions().length] as const,
    async (): Promise<OutlineItem[]> => {
      const f = activeFile();
      if (!f) return [];
      const lspLang = lspLanguageForFile(f.relPath);
      if (lspLang) {
        const session = findSession(lspLang);
        if (session) {
          const syms = await requestDocumentSymbols(session, pathToFileUri(f.path));
          if (syms && syms.length > 0) return syms;
        }
      }
      const outlineLang = outlineLangFor(f.relPath);
      return outlineLang ? parseOutline(f.content, outlineLang) : [];
    },
    { initialValue: [] },
  );
  const outline = () => outlineRes() ?? [];

  const [collapsedNodes, setCollapsedNodes] = createSignal<Set<string>>(new Set());
  const toggleNode = (key: string) =>
    setCollapsedNodes((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  // The active section = the last heading at or above the cursor (DFS order is
  // document order, so line-ascending).
  const activeKey = createMemo<string | null>(() => {
    const line = cursorLine();
    if (line == null) return null;
    let best: OutlineItem | null = null;
    for (const it of flatten(outline())) {
      if (it.line <= line) best = it;
      else break;
    }
    return best ? nodeKey(best) : null;
  });

  const canOutline = () =>
    Boolean(activeFile() && outlineLangFor(activeFile()!.relPath));

  return (
    <div class="flex-shrink-0 border-t border-glass-stroke">
      <button
        type="button"
        onClick={props.onToggle}
        class="lift flex h-9 w-full items-center gap-2 px-3 hover:bg-[var(--color-control-fill)]"
      >
        <ListTree size={12} style={{ opacity: 0.65 }} />
        <span class="text-sm font-medium text-fg-2">Outline</span>
        <span class="mono text-[10px] text-fg-3">document structure</span>
        <Show
          when={props.collapsed}
          fallback={<ChevronDown size={12} class="ml-auto opacity-55" />}
        >
          <ChevronUp size={12} class="ml-auto opacity-55" />
        </Show>
      </button>
      <Show when={!props.collapsed}>
        <div class="max-h-[38vh] overflow-auto scroll py-1">
          <Show
            when={outline().length > 0}
            fallback={
              <div class="px-3 py-1.5 text-xs italic text-fg-3">
                {canOutline()
                  ? "No headings in this file."
                  : "Outline unavailable for this file type."}
              </div>
            }
          >
            <For each={outline()}>
              {(item) => (
                <OutlineNode
                  item={item}
                  depth={0}
                  collapsed={collapsedNodes()}
                  toggle={toggleNode}
                  activeKey={activeKey()}
                  onJump={setCursorLine}
                />
              )}
            </For>
          </Show>
        </div>
      </Show>
    </div>
  );
};

const OutlineNode: Component<{
  item: OutlineItem;
  depth: number;
  collapsed: Set<string>;
  toggle: (key: string) => void;
  activeKey: string | null;
  onJump: (line: number) => void;
}> = (props) => {
  const key = () => nodeKey(props.item);
  const hasChildren = () => props.item.children.length > 0;
  const isCollapsed = () => props.collapsed.has(key());
  const active = () => props.activeKey === key();
  return (
    <div>
      <div
        class="group flex items-center gap-1 rounded pr-2 hover:bg-[var(--color-control-fill)]"
        style={{ "padding-left": `${8 + props.depth * 12}px` }}
      >
        <Show
          when={hasChildren()}
          fallback={<span class="inline-block w-3.5 flex-shrink-0" />}
        >
          <button
            type="button"
            aria-label={isCollapsed() ? "Expand" : "Collapse"}
            onClick={() => props.toggle(key())}
            class="flex h-4 w-3.5 flex-shrink-0 items-center justify-center text-fg-3"
          >
            <Show when={isCollapsed()} fallback={<ChevronDown size={11} />}>
              <ChevronRight size={11} />
            </Show>
          </button>
        </Show>
        <button
          type="button"
          onClick={() => props.onJump(props.item.line)}
          class="min-w-0 flex-1 truncate py-1 text-left text-xs"
          classList={{
            "font-medium text-fg-1": active(),
            "text-fg-2": !active(),
          }}
          title={props.item.title}
        >
          {props.item.title}
        </button>
      </div>
      <Show when={hasChildren() && !isCollapsed()}>
        <For each={props.item.children}>
          {(child) => (
            <OutlineNode
              item={child}
              depth={props.depth + 1}
              collapsed={props.collapsed}
              toggle={props.toggle}
              activeKey={props.activeKey}
              onJump={props.onJump}
            />
          )}
        </For>
      </Show>
    </div>
  );
};
