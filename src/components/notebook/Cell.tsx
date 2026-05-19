import {
  ChevronDown,
  ChevronUp,
  Code,
  Hash,
  Loader2,
  MoreHorizontal,
  Play,
  Plus,
  Settings as SettingsIcon,
  Trash,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { Match, Show, Switch, createMemo } from "solid-js";
import type { Cell as CellType } from "~/lib/notebook/parser";
import { CellEditor } from "~/components/editor/CellEditor";
import {
  activeCellId,
  changeCellLanguage,
  deleteCell,
  moveCell,
  setActiveCellId,
  updateCellContent,
} from "~/stores/notebook-store";

const LANGUAGE_LABEL: Record<string, string> = {
  r: "R",
  python: "Python",
  julia: "Julia",
  sql: "SQL",
  bash: "Shell",
  sh: "Shell",
  shell: "Shell",
};

const LANGUAGE_OPTIONS = ["r", "python", "julia", "sql", "bash"];

interface CellProps {
  cell: CellType;
  /** Total cells in the notebook — used to disable move buttons at boundaries. */
  total: number;
  /** 0-based index in the cell list. */
  index: number;
  /** Add-cell handler invoked by the bottom "+" affordance. */
  onAddBelow: () => void;
  /**
   * Execution slot — only meaningful for code cells. When omitted, the
   * Run button is hidden. Passes the cell id so the runner can find the
   * source content via the notebook store.
   */
  onRun?: (cellId: string) => void;
  /** Whether this cell is currently being executed. */
  running?: boolean;
  /** Rendered below the editor. Output components live in NotebookShell. */
  output?: JSX.Element;
}

/**
 * Visual unit of the notebook. A card hosting:
 *   - Type / language indicator (left)
 *   - Reorder + run + delete controls (right)
 *   - The per-cell CodeMirror editor
 *   - An output slot (for code cells)
 *
 * Clicking anywhere on the card promotes it to "active cell" so global
 * shortcuts (Run cell, Delete cell, etc.) target it.
 */
export const Cell: Component<CellProps> = (props) => {
  const active = createMemo(() => activeCellId() === props.cell.id);

  const promote = () => setActiveCellId(props.cell.id);

  return (
    <div
      class="relative"
      onMouseDown={promote}
      onFocusIn={promote}
      data-cell-id={props.cell.id}
    >
      <div
        class={`lift glass-soft overflow-hidden rounded-lg transition ${
          active()
            ? "ring-1 ring-[var(--color-accent-1)]/40 bg-[var(--color-control-fill)]"
            : "hover:bg-[var(--color-control-fill)]"
        }`}
      >
        <CellToolbar
          cell={props.cell}
          index={props.index}
          total={props.total}
          running={props.running}
          onRun={props.onRun}
        />
        <div class="px-1 py-1">
          <CellBody cell={props.cell} />
        </div>
        <Show when={props.cell.kind === "code" && props.output}>
          <div class="border-t border-glass-stroke">{props.output}</div>
        </Show>
      </div>

      <AddCellButton onClick={props.onAddBelow} />
    </div>
  );
};

const CellToolbar: Component<{
  cell: CellType;
  index: number;
  total: number;
  running?: boolean;
  onRun?: (cellId: string) => void;
}> = (props) => {
  const language = () =>
    props.cell.kind === "code" ? props.cell.language : null;

  return (
    <div class="flex h-7 items-center gap-1.5 border-b border-glass-stroke px-2.5 text-[11px] text-fg-3">
      <Switch>
        <Match when={props.cell.kind === "metadata"}>
          <SettingsIcon size={11} style={{ opacity: 0.6 }} />
          <span class="mono">metadata</span>
        </Match>
        <Match when={props.cell.kind === "markdown"}>
          <Hash size={11} style={{ opacity: 0.6 }} />
          <span class="mono">markdown</span>
        </Match>
        <Match when={props.cell.kind === "code"}>
          <Code size={11} style={{ color: "var(--color-accent-1)" }} />
          <LanguagePicker
            value={language() ?? "r"}
            onChange={(next) => changeCellLanguage(props.cell.id, next)}
          />
        </Match>
      </Switch>
      <span class="mono ml-auto text-fg-4">
        #{props.index + 1}/{props.total}
      </span>
      <Show when={props.cell.kind === "code" && props.onRun}>
        <button
          type="button"
          onClick={() => props.onRun?.(props.cell.id)}
          disabled={props.running}
          class="lift flex h-5 items-center gap-1 rounded px-1.5 text-[10px] font-medium text-white disabled:opacity-50"
          style={{
            background:
              "linear-gradient(135deg, var(--color-accent-1), var(--color-accent-2))",
          }}
          title="Run this cell"
        >
          <Show when={props.running} fallback={<Play size={9} stroke-width={2.4} />}>
            <Loader2 size={9} class="animate-spin" />
          </Show>
          <span>Run</span>
        </button>
      </Show>
      <button
        type="button"
        onClick={() => moveCell(props.cell.id, "up")}
        disabled={props.index === 0}
        class="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill)] disabled:opacity-30"
        title="Move up"
      >
        <ChevronUp size={11} />
      </button>
      <button
        type="button"
        onClick={() => moveCell(props.cell.id, "down")}
        disabled={props.index >= props.total - 1}
        class="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill)] disabled:opacity-30"
        title="Move down"
      >
        <ChevronDown size={11} />
      </button>
      <Show when={props.cell.kind !== "metadata"}>
        <button
          type="button"
          onClick={() => deleteCell(props.cell.id)}
          disabled={props.total <= 1}
          class="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill)] disabled:opacity-30"
          title="Delete cell"
        >
          <Trash size={11} />
        </button>
      </Show>
      <button
        type="button"
        class="flex h-5 w-5 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
        title="More"
      >
        <MoreHorizontal size={11} />
      </button>
    </div>
  );
};

const LanguagePicker: Component<{
  value: string;
  onChange: (v: string) => void;
}> = (props) => (
  <span class="flex items-center gap-1">
    <span class="mono">code</span>
    <span class="text-fg-4">·</span>
    <select
      value={props.value}
      onChange={(e) => props.onChange(e.currentTarget.value)}
      class="mono cursor-pointer rounded border-0 bg-transparent px-1 py-0 text-[11px] text-fg-2 outline-none hover:bg-[var(--color-control-fill)]"
      style={{ "appearance": "none" }}
    >
      {LANGUAGE_OPTIONS.map((lang) => (
        <option value={lang}>{LANGUAGE_LABEL[lang] ?? lang}</option>
      ))}
      <Show
        when={!LANGUAGE_OPTIONS.includes(props.value)}
      >
        <option value={props.value}>{props.value}</option>
      </Show>
    </select>
  </span>
);

const CellBody: Component<{ cell: CellType }> = (props) => {
  const onCellChange = (next: string) =>
    updateCellContent(props.cell.id, next);
  const onFocus = () => setActiveCellId(props.cell.id);

  return (
    <Switch>
      <Match when={props.cell.kind === "metadata"}>
        <CellEditor
          value={props.cell.content}
          onChange={onCellChange}
          language="yaml"
          onFocus={onFocus}
        />
      </Match>
      <Match when={props.cell.kind === "markdown"}>
        <CellEditor
          value={props.cell.content}
          onChange={onCellChange}
          language="markdown"
          onFocus={onFocus}
        />
      </Match>
      <Match when={props.cell.kind === "code"}>
        <CellEditor
          value={props.cell.content}
          onChange={onCellChange}
          language={
            props.cell.kind === "code" ? props.cell.language : "plain"
          }
          onFocus={onFocus}
        />
      </Match>
    </Switch>
  );
};

const AddCellButton: Component<{ onClick: () => void }> = (props) => (
  <div class="relative h-3">
    <button
      type="button"
      onClick={props.onClick}
      class="group absolute inset-x-0 -top-0.5 flex h-3 items-center justify-center"
      title="Add cell below"
    >
      <span
        class="h-px flex-1 transition group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--color-accent-1), transparent)",
          opacity: 0,
        }}
      />
      <span
        class="lift flex h-4 items-center gap-1 rounded-full px-1.5 text-[10px] font-medium opacity-0 transition group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(135deg, var(--color-accent-1), var(--color-accent-2))",
          color: "white",
        }}
      >
        <Plus size={9} stroke-width={2.4} />
        cell
      </span>
      <span
        class="h-px flex-1 transition group-hover:opacity-100"
        style={{
          background:
            "linear-gradient(90deg, transparent, var(--color-accent-1), transparent)",
          opacity: 0,
        }}
      />
    </button>
  </div>
);
