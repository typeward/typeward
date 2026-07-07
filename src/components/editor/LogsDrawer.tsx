/**
 * Bottom drawer ported from `design_files/Editor.html` (LogsDrawer, line
 * 7921+). Lives below the three-pane editor area and houses build output and
 * parsed diagnostics. Collapsible to a 36px header strip when minimized.
 *
 * Five tabs — All logs / Errors / Warnings / Info / Grammar — each icon + name
 * + counter only (no subheadings). The same tab set + bodies back both the
 * drawer and the in-preview `LogsView` variant.
 */

import {
  AlertTriangle,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  Info,
  SpellCheck,
  Terminal,
  XCircle,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { compileState, lastResult, requestGotoSource } from "~/stores/editor-store";
import { grammarTotalCount } from "~/stores/grammar-store";
import { logsTabIntent } from "~/stores/ui-store";
import { formatShortcutForDisplay } from "~/lib/shortcuts";
import { GrammarProblemsPanel } from "./GrammarProblemsPanel";

const TAB_IDS: readonly LogsTabId[] = ["all", "errors", "warnings", "info", "grammar"];
function asLogsTabId(raw: string): LogsTabId | null {
  return (TAB_IDS as readonly string[]).includes(raw) ? (raw as LogsTabId) : null;
}

type LogsTabId = "all" | "errors" | "warnings" | "info" | "grammar";
type DiagSeverity = "error" | "warning" | "info";

interface LogsTabDef {
  id: LogsTabId;
  label: string;
  icon: Component<{ size?: number; class?: string }>;
}

const TABS: LogsTabDef[] = [
  { id: "all", label: "All logs", icon: Terminal },
  { id: "errors", label: "Errors", icon: XCircle },
  { id: "warnings", label: "Warnings", icon: AlertTriangle },
  { id: "info", label: "Info", icon: Info },
  { id: "grammar", label: "Grammar", icon: SpellCheck },
];

function diagCount(severity: DiagSeverity): number {
  return lastResult()?.diagnostics.filter((d) => d.severity === severity).length ?? 0;
}

/** Per-tab counter values. `all` has no badge. */
function tabCounts(): Record<LogsTabId, number> {
  return {
    all: 0,
    errors: diagCount("error"),
    warnings: diagCount("warning"),
    info: diagCount("info"),
    grammar: grammarTotalCount(),
  };
}

/**
 * `embedded` — when true, the drawer fills its parent's height and the
 * minimize chrome is hidden. Used when the panel is mounted inside the
 * PDF preview pane (`consolePosition === "pdf-tab"`).
 */
export const LogsDrawer: Component<{ embedded?: boolean }> = (props) => {
  const [tab, setTab] = createSignal<LogsTabId>("errors");
  const [minimized, setMinimized] = createSignal(!props.embedded);

  const errs = createMemo(() => diagCount("error"));
  const warns = createMemo(() => diagCount("warning"));
  const counts = createMemo(tabCounts);

  const handleSelectTab = (id: LogsTabId) => {
    setTab(id);
    if (minimized()) setMinimized(false);
  };

  // Auto-expand on compile failure so diagnostics surface without a click.
  createEffect(
    on(compileState, (state) => {
      if (state === "error") {
        setMinimized(false);
        setTab("errors");
      }
    }),
  );

  // Status-bar "N problems" (and any future caller) can raise a specific tab.
  createEffect(
    on(
      logsTabIntent,
      (intent) => {
        if (!intent) return;
        const id = asLogsTabId(intent.tab);
        if (!id) return;
        setTab(id);
        setMinimized(false);
      },
      { defer: true },
    ),
  );

  return (
    <div
      class="glass flex flex-col overflow-hidden rounded-xl"
      style={
        props.embedded
          ? { height: "100%" }
          : { height: minimized() ? "36px" : "240px" }
      }
    >
      {/* Header */}
      <div class="flex h-9 flex-shrink-0 items-center gap-0.5 border-b border-glass-stroke px-2">
        <div role="tablist" aria-label="Log panels" class="flex items-center gap-0.5 overflow-x-auto scroll">
          <For each={TABS}>
            {(t) => {
              const active = () => tab() === t.id && !minimized();
              const count = () => counts()[t.id];
              return (
                <button
                  type="button"
                  role="tab"
                  aria-selected={active()}
                  onClick={() => handleSelectTab(t.id)}
                  class={`relative flex h-8 flex-shrink-0 items-center gap-1.5 px-2.5 text-sm font-medium ${
                    active() ? "text-fg-1" : "text-fg-3 hover:text-fg-2"
                  }`}
                >
                  <t.icon size={12} class="" />
                  {t.label}
                  <Show when={count() > 0}>
                    <span
                      class="mono rounded-full px-1.5 py-0.5 text-[10px]"
                      style={{
                        background: active()
                          ? "color-mix(in srgb, var(--color-accent-1) 18%, transparent)"
                          : "var(--color-control-fill)",
                        color: active() ? "var(--color-accent-1)" : "var(--color-fg-3)",
                      }}
                    >
                      {count()}
                    </span>
                  </Show>
                  <Show when={active()}>
                    <span
                      class="absolute -bottom-px left-2.5 right-2.5 h-[2px] rounded"
                      style={{
                        background:
                          "linear-gradient(90deg, var(--color-accent-1), var(--color-accent-2))",
                      }}
                    />
                  </Show>
                </button>
              );
            }}
          </For>
        </div>

        <div class="ml-auto flex items-center gap-1.5">
          {/* Inline status pills — always visible, even when minimized */}
          <Show when={lastResult()}>
            <StatusPill
              dot={
                compileState() === "ok"
                  ? "var(--color-ok)"
                  : compileState() === "error"
                    ? "var(--color-err)"
                    : "var(--color-warn)"
              }
            >
              {lastResult()!.durationMs}ms
            </StatusPill>
            <Show when={errs() > 0}>
              <StatusPill icon={<XCircle size={10} />} tint="var(--color-err)">
                {errs()} error{errs() === 1 ? "" : "s"}
              </StatusPill>
            </Show>
            <Show when={warns() > 0}>
              <StatusPill icon={<AlertTriangle size={10} />} tint="var(--color-warn)">
                {warns()} warning{warns() === 1 ? "" : "s"}
              </StatusPill>
            </Show>
          </Show>

          <Show when={!props.embedded}>
            <div class="mx-1 h-4 w-px bg-glass-stroke" />
            <button
              type="button"
              onClick={() => setMinimized((v) => !v)}
              title={minimized() ? "Expand" : "Minimize"}
              aria-label={minimized() ? "Expand logs" : "Minimize logs"}
              class="lift flex h-7 w-7 items-center justify-center rounded hover:bg-[var(--color-control-fill)]"
            >
              <Show when={minimized()} fallback={<ChevronsDown size={12} class="opacity-60" />}>
                <ChevronsUp size={12} class="opacity-60" />
              </Show>
            </button>
          </Show>
        </div>
      </div>

      {/* Body */}
      <Show when={props.embedded || !minimized()}>
        <div class="min-h-0 flex-1 overflow-auto scroll">
          <TabBody tab={tab()} />
        </div>
      </Show>
    </div>
  );
};

const StatusPill: Component<{
  children: JSX.Element;
  dot?: string;
  icon?: JSX.Element;
  tint?: string;
}> = (props) => (
  <span
    class="mono glass-soft flex h-6 items-center gap-1.5 rounded-full px-2 text-xs"
    style={props.tint ? { color: props.tint } : { color: "var(--color-fg-2)" }}
  >
    <Show when={props.dot}>
      <span class="h-1.5 w-1.5 rounded-full" style={{ background: props.dot }} />
    </Show>
    {props.icon}
    {props.children}
  </span>
);

// Shared body switch for both the drawer and the in-preview LogsView.
const TabBody: Component<{ tab: LogsTabId }> = (props) => (
  <Switch>
    <Match when={props.tab === "all"}>
      <LogsTabBody />
    </Match>
    <Match when={props.tab === "errors"}>
      <DiagnosticsTab severity="error" primary />
    </Match>
    <Match when={props.tab === "warnings"}>
      <DiagnosticsTab severity="warning" />
    </Match>
    <Match when={props.tab === "info"}>
      <DiagnosticsTab severity="info" />
    </Match>
    <Match when={props.tab === "grammar"}>
      <GrammarProblemsPanel />
    </Match>
  </Switch>
);

// =================================================================
// All logs tab — raw build output
// =================================================================

const LogsTabBody: Component = () => {
  const log = createMemo(() => lastResult()?.log ?? "");
  return (
    <Show
      when={log().trim().length > 0}
      fallback={
        <EmptyTab
          title="No build log yet"
          body={`Hit Compile (${formatShortcutForDisplay("Mod+Enter")}) to see compiler output here.`}
        />
      }
    >
      <pre class="mono select-text whitespace-pre-wrap p-3 text-xs leading-[1.55] text-fg-2">
        {log()}
      </pre>
    </Show>
  );
};

// =================================================================
// Errors / Warnings / Info — one flat IssueCard list per severity.
// The `primary` (Errors) tab also carries the success + raw-log-tail cards.
// =================================================================

const SEVERITY_ICON: Record<DiagSeverity, Component<{ size?: number }>> = {
  error: XCircle,
  warning: AlertTriangle,
  info: Info,
};

const DiagnosticsTab: Component<{ severity: DiagSeverity; primary?: boolean }> = (props) => {
  const result = lastResult;
  const items = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === props.severity) ?? [],
  );
  const errs = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "error") ?? [],
  );
  const warns = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "warning") ?? [],
  );
  const Icon = SEVERITY_ICON[props.severity];

  return (
    <Show
      when={result()}
      fallback={
        <EmptyTab
          title="Nothing yet"
          body="Compile a document to surface diagnostics here."
        />
      }
    >
      <div class="space-y-2 p-3">
        <For each={items()}>
          {(d) => (
            <IssueCard
              severity={props.severity}
              icon={<Icon size={12} />}
              title={d.message}
              meta={`${d.file}:${d.line}`}
              onJump={d.file ? () => requestGotoSource(d.file, d.line) : undefined}
            />
          )}
        </For>
        {/* Non-primary tabs: a quiet empty state when this severity is clear. */}
        <Show when={!props.primary && items().length === 0}>
          <EmptyTab title="Nothing here" body="No diagnostics of this kind." />
        </Show>
        {/* Errors tab only: success + failure summary cards. */}
        <Show when={props.primary && result()!.ok && errs().length === 0 && warns().length === 0}>
          <IssueCard
            severity="success"
            icon={<CheckCircle2 size={12} />}
            title="Compiled successfully"
            meta={`${result()!.durationMs}ms`}
          />
        </Show>
        <Show when={props.primary && !result()!.ok && errs().length === 0}>
          <div
            class="rounded-lg p-3"
            style={{
              background: "var(--color-control-fill)",
              border: "1px solid var(--color-control-stroke)",
              "border-left": "2px solid var(--color-err)",
            }}
          >
            <div class="flex items-start gap-2.5">
              <div
                class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
                style={{ background: "color-mix(in srgb, var(--color-err) 12%, transparent)" }}
              >
                <XCircle size={12} style={{ color: "var(--color-err)" }} />
              </div>
              <div class="flex-1">
                <div class="text-sm font-semibold" style={{ color: "var(--color-err)" }}>
                  Compile failed — see the All logs tab for full output
                </div>
                <pre class="mono select-text mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap text-xs text-fg-3 scroll">
                  {result()!.log.slice(-500)}
                </pre>
              </div>
            </div>
          </div>
        </Show>
      </div>
    </Show>
  );
};

const SEVERITY_FG: Record<"error" | "warning" | "info" | "success", string> = {
  error: "var(--color-err)",
  warning: "var(--color-warn)",
  info: "var(--color-fg-3)",
  success: "var(--color-ok)",
};

/** `onJump` makes the card clickable — jumps the editor to file:line. */
const IssueCard: Component<{
  severity: "error" | "warning" | "info" | "success";
  icon: JSX.Element;
  title: string;
  meta: string;
  onJump?: () => void;
}> = (props) => (
  <button
    type="button"
    disabled={!props.onJump}
    onClick={() => props.onJump?.()}
    title={props.onJump ? "Jump to source" : undefined}
    class="block w-full rounded-lg p-3 text-left enabled:hover:bg-[var(--color-control-fill-hover)]"
    style={{
      background: "var(--color-control-fill)",
      border: "1px solid var(--color-control-stroke)",
      "border-left": `2px solid ${SEVERITY_FG[props.severity]}`,
    }}
  >
    <div class="flex items-start gap-2.5">
      <div
        class="flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-md"
        style={{
          background: `color-mix(in srgb, ${SEVERITY_FG[props.severity]} 12%, transparent)`,
          color: SEVERITY_FG[props.severity],
        }}
      >
        {props.icon}
      </div>
      <div class="flex-1 min-w-0">
        <div class="flex items-center gap-2">
          <span
            class="select-text text-sm font-semibold"
            style={{ color: SEVERITY_FG[props.severity] }}
          >
            {props.title}
          </span>
          <span class="mono select-text text-xs text-fg-3">{props.meta}</span>
        </div>
      </div>
    </div>
  </button>
);

const EmptyTab: Component<{ title: string; body: string }> = (props) => (
  <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
    <div class="text-base font-semibold text-fg-1">{props.title}</div>
    <div class="max-w-[380px] text-xs leading-relaxed text-fg-3">{props.body}</div>
  </div>
);

// =================================================================
// LogsView — full-pane variant rendered inside the preview pane when
// `consolePosition === "pdf-tab"` and `previewMode === "console"`. Same five
// tabs as the drawer, rendered as a compact selector row (icon + name + count).
// =================================================================

export const LogsView: Component = () => {
  const [tab, setTab] = createSignal<LogsTabId>("all");
  const counts = createMemo(tabCounts);

  // The preview switch into console mode is owned by the caller (status bar);
  // this only picks the requested tab once the view is mounted.
  createEffect(
    on(
      logsTabIntent,
      (intent) => {
        if (!intent) return;
        const id = asLogsTabId(intent.tab);
        if (id) setTab(id);
      },
      { defer: true },
    ),
  );

  return (
    <div class="flex h-full flex-col gap-2 p-2" style={{ background: "var(--color-overlay-dim)" }}>
      <div class="grid flex-shrink-0 grid-cols-5 gap-1.5">
        <For each={TABS}>
          {(t) => (
            <CompactSelector
              active={tab() === t.id}
              onClick={() => setTab(t.id)}
              icon={<t.icon size={13} />}
              label={t.label}
              count={counts()[t.id] || undefined}
            />
          )}
        </For>
      </div>

      <div
        class="glass-soft flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl"
        style={{ border: "1px solid var(--color-glass-stroke)" }}
      >
        <div class="min-h-0 flex-1 overflow-auto scroll">
          <TabBody tab={tab()} />
        </div>
      </div>
    </div>
  );
};

const CompactSelector: Component<{
  active: boolean;
  onClick: () => void;
  icon: JSX.Element;
  label: string;
  count?: number;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    aria-pressed={props.active}
    class="lift glass-soft flex min-w-0 flex-col items-center gap-1 rounded-lg px-1.5 py-2 text-center"
    style={
      props.active
        ? {
            background: "color-mix(in srgb, var(--color-accent-1) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-accent-1) 45%, transparent)",
            color: "var(--color-accent-1)",
          }
        : { border: "1px solid var(--color-glass-stroke)", color: "var(--color-fg-2)" }
    }
  >
    <span class="flex items-center gap-1">
      {props.icon}
      <Show when={props.count !== undefined && props.count > 0}>
        <span class="mono rounded-full px-1 text-[10px]" style={{ background: "var(--color-control-fill)" }}>
          {props.count}
        </span>
      </Show>
    </span>
    <span class="block w-full truncate text-[11px] font-medium">{props.label}</span>
  </button>
);
