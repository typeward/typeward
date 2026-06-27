/**
 * Bottom drawer ported from `design_files/Editor.html` (LogsDrawer, line
 * 7921+). Lives below the three-pane editor area and houses build output,
 * parsed issues, and (later) bibliography / chat. Collapsible to a 36px
 * header strip when minimized.
 *
 * Phase 1 wires the two functional tabs (Logs / Issues); Bibliography and
 * Chat are empty-state placeholders until the relevant features land.
 */

import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  ChevronsDown,
  ChevronsUp,
  Terminal,
  XCircle,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Match, Show, Switch, createEffect, createMemo, createSignal, on } from "solid-js";
import { compileState, lastResult, requestGotoSource } from "~/stores/editor-store";
import { formatShortcutForDisplay } from "~/lib/shortcuts";

type LogsTabId = "logs" | "issues";

interface LogsTabDef {
  id: LogsTabId;
  label: string;
  icon: Component<{ size?: number; class?: string }>;
}

const TABS: LogsTabDef[] = [
  { id: "logs", label: "Logs", icon: Terminal },
  { id: "issues", label: "Issues", icon: AlertCircle },
];

/**
 * `embedded` — when true, the drawer fills its parent's height and the
 * minimize chrome is hidden. Used when the panel is mounted inside the
 * PDF preview pane (`consolePosition === "pdf-tab"`).
 */
export const LogsDrawer: Component<{ embedded?: boolean }> = (props) => {
  const [tab, setTab] = createSignal<LogsTabId>("issues");
  const [minimized, setMinimized] = createSignal(!props.embedded);

  const result = lastResult;
  const errs = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "error") ?? [],
  );
  const warns = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "warning") ?? [],
  );
  const counts = createMemo<Record<LogsTabId, number>>(() => ({
    logs: 0,
    issues: errs().length + warns().length,
  }));

  const handleSelectTab = (id: LogsTabId) => {
    setTab(id);
    if (minimized()) setMinimized(false);
  };

  // Auto-expand on compile failure so diagnostics surface without a click.
  createEffect(
    on(compileState, (state) => {
      if (state === "error") {
        setMinimized(false);
        setTab("issues");
      }
    }),
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
        <For each={TABS}>
          {(t) => {
            const active = () => tab() === t.id && !minimized();
            const count = () => counts()[t.id];
            return (
              <button
                type="button"
                onClick={() => handleSelectTab(t.id)}
                class={`relative flex h-8 items-center gap-1.5 px-2.5 text-[12px] font-medium ${
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

        <div class="ml-auto flex items-center gap-1.5">
          {/* Inline status pills — always visible, even when minimized */}
          <Show when={result()}>
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
            <Show when={errs().length > 0}>
              <StatusPill
                icon={<XCircle size={10} />}
                tint="var(--color-err)"
              >
                {errs().length} error{errs().length === 1 ? "" : "s"}
              </StatusPill>
            </Show>
            <Show when={warns().length > 0}>
              <StatusPill
                icon={<AlertTriangle size={10} />}
                tint="var(--color-warn)"
              >
                {warns().length} warning{warns().length === 1 ? "" : "s"}
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

      {/* Body — always visible when embedded, gated on minimize state otherwise. */}
      <Show when={props.embedded || !minimized()}>
        <div class="min-h-0 flex-1 overflow-auto scroll">
          <Switch>
            <Match when={tab() === "logs"}>
              <LogsTabBody />
            </Match>
            <Match when={tab() === "issues"}>
              <IssuesTabBody />
            </Match>
          </Switch>
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
    class="mono glass-soft flex h-6 items-center gap-1.5 rounded-full px-2 text-[11px]"
    style={props.tint ? { color: props.tint } : { color: "var(--color-fg-2)" }}
  >
    <Show when={props.dot}>
      <span
        class="h-1.5 w-1.5 rounded-full"
        style={{ background: props.dot }}
      />
    </Show>
    {props.icon}
    {props.children}
  </span>
);

// =================================================================
// Logs tab — raw build output
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
      <pre class="mono whitespace-pre-wrap p-3 text-[11px] leading-[1.55] text-fg-2">
        {log()}
      </pre>
    </Show>
  );
};

// =================================================================
// Issues tab — parsed diagnostics + success/failure summary card
// =================================================================

const IssuesTabBody: Component = () => {
  const result = lastResult;
  const errs = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "error") ?? [],
  );
  const warns = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "warning") ?? [],
  );

  return (
    <Show
      when={result()}
      fallback={
        <EmptyTab
          title="No issues"
          body="Compile a document to surface errors and warnings here."
        />
      }
    >
      <div class="space-y-2 p-3">
        <For each={errs()}>
          {(d) => (
            <IssueCard
              severity="error"
              icon={<XCircle size={12} />}
              title={d.message}
              meta={`${d.file}:${d.line}`}
              onJump={d.file ? () => requestGotoSource(d.file, d.line) : undefined}
            />
          )}
        </For>
        <For each={warns()}>
          {(d) => (
            <IssueCard
              severity="warning"
              icon={<AlertTriangle size={12} />}
              title={d.message}
              meta={`${d.file}:${d.line}`}
              onJump={d.file ? () => requestGotoSource(d.file, d.line) : undefined}
            />
          )}
        </For>
        <Show when={result()!.ok && errs().length === 0 && warns().length === 0}>
          <IssueCard
            severity="success"
            icon={<CheckCircle2 size={12} />}
            title="Compiled successfully"
            meta={`${result()!.durationMs}ms`}
          />
        </Show>
        <Show when={!result()!.ok && errs().length === 0 && warns().length === 0}>
          {/* Build failed but log parser didn't pick anything up — surface
            * the raw log so the user can see what happened. */}
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
                <div class="text-[12px] font-semibold" style={{ color: "var(--color-err)" }}>
                  Compile failed — see the Logs tab for full output
                </div>
                <pre class="mono mt-2 max-h-[120px] overflow-auto whitespace-pre-wrap text-[11px] leading-[1.5] text-fg-3 scroll">
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

const SEVERITY_FG: Record<"error" | "warning" | "success", string> = {
  error: "var(--color-err)",
  warning: "var(--color-warn)",
  success: "var(--color-ok)",
};

/** `onJump` makes the card clickable — jumps the editor to file:line. */
const IssueCard: Component<{
  severity: "error" | "warning" | "success";
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
    class="block w-full rounded-lg p-3 text-left disabled:cursor-default enabled:cursor-pointer enabled:hover:bg-[var(--color-control-fill-hover)]"
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
            class="text-[12px] font-semibold"
            style={{ color: SEVERITY_FG[props.severity] }}
          >
            {props.title}
          </span>
          <span class="mono text-[11px] text-fg-3">{props.meta}</span>
        </div>
      </div>
    </div>
  </button>
);

const EmptyTab: Component<{ title: string; body: string }> = (props) => (
  <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-8 text-center">
    <div class="text-[13px] font-semibold text-fg-1">{props.title}</div>
    <div class="max-w-[380px] text-[11px] leading-relaxed text-fg-3">
      {props.body}
    </div>
  </div>
);

// =================================================================
// LogsView — full-pane variant rendered inside the preview pane when
// `consolePosition === "pdf-tab"` and `previewMode === "console"`.
// Two selectable cards (Logs / Issues) switch a single content panel.
// =================================================================

export const LogsView: Component = () => {
  const [tab, setTab] = createSignal<LogsTabId>("logs");
  const result = lastResult;
  const errs = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "error") ?? [],
  );
  const warns = createMemo(
    () => result()?.diagnostics.filter((d) => d.severity === "warning") ?? [],
  );
  const issueCount = () => errs().length + warns().length;

  const logsSubtitle = () => {
    const log = result()?.log?.trim();
    if (!log) return "No build output yet";
    const lines = log.split("\n").length;
    return `${lines} line${lines === 1 ? "" : "s"} of output`;
  };
  const issuesSubtitle = () => {
    if (!result()) return "Compile to surface diagnostics";
    if (issueCount() === 0) return "No errors or warnings";
    const parts: string[] = [];
    if (errs().length > 0)
      parts.push(`${errs().length} error${errs().length === 1 ? "" : "s"}`);
    if (warns().length > 0)
      parts.push(
        `${warns().length} warning${warns().length === 1 ? "" : "s"}`,
      );
    return parts.join(", ");
  };

  return (
    <div
      class="flex h-full flex-col gap-2 p-2"
      style={{ background: "var(--color-overlay-dim)" }}
    >
      <div class="grid flex-shrink-0 grid-cols-2 gap-2">
        <SelectorCard
          active={tab() === "logs"}
          onClick={() => setTab("logs")}
          icon={<Terminal size={14} />}
          label="Logs"
          subtitle={logsSubtitle()}
        />
        <SelectorCard
          active={tab() === "issues"}
          onClick={() => setTab("issues")}
          icon={<AlertCircle size={14} />}
          label="Issues"
          subtitle={issuesSubtitle()}
          count={issueCount() || undefined}
        />
      </div>

      <div
        class="glass-soft flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl"
        style={{ border: "1px solid var(--color-glass-stroke)" }}
      >
        <div class="min-h-0 flex-1 overflow-auto scroll">
          <Switch>
            <Match when={tab() === "logs"}>
              <LogsTabBody />
            </Match>
            <Match when={tab() === "issues"}>
              <IssuesTabBody />
            </Match>
          </Switch>
        </div>
      </div>
    </div>
  );
};

const SelectorCard: Component<{
  active: boolean;
  onClick: () => void;
  icon: JSX.Element;
  label: string;
  subtitle: string;
  count?: number;
}> = (props) => (
  <button
    type="button"
    onClick={props.onClick}
    aria-pressed={props.active}
    class="lift glass-soft flex items-center gap-2.5 rounded-xl px-3 py-2 text-left"
    style={
      props.active
        ? {
            background: "color-mix(in srgb, var(--color-accent-1) 10%, transparent)",
            border: "1px solid color-mix(in srgb, var(--color-accent-1) 45%, transparent)",
          }
        : {
            border: "1px solid var(--color-glass-stroke)",
          }
    }
  >
    <span
      class="flex h-7 w-7 flex-shrink-0 items-center justify-center rounded-md"
      style={{
        background: props.active
          ? "color-mix(in srgb, var(--color-accent-1) 18%, transparent)"
          : "var(--color-control-fill)",
        color: props.active ? "var(--color-accent-1)" : "var(--color-fg-2)",
      }}
    >
      {props.icon}
    </span>
    <span class="min-w-0 flex-1">
      <span
        class={`block text-[12px] font-semibold ${
          props.active ? "text-fg-1" : "text-fg-2"
        }`}
      >
        {props.label}
      </span>
      <span class="block truncate text-[10px] text-fg-3">{props.subtitle}</span>
    </span>
    <Show when={props.count !== undefined && props.count > 0}>
      <span
        class="mono rounded-full px-1.5 py-0.5 text-[10px]"
        style={{
          background: props.active
            ? "color-mix(in srgb, var(--color-accent-1) 18%, transparent)"
            : "var(--color-control-fill)",
          color: props.active ? "var(--color-accent-1)" : "var(--color-fg-3)",
        }}
      >
        {props.count}
      </span>
    </Show>
  </button>
);
