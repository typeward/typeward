import {
  Bug,
  ChevronDown,
  ChevronRight,
  Copy,
  Download,
  RefreshCw,
  Send,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createResource, createSignal } from "solid-js";
import { Switch } from "~/components/forms/Switch";
import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import * as ipc from "~/ipc";
import { formatSystemInfo, openBugReport } from "~/lib/bug-report";
import { describeIpcError } from "~/lib/errors";
import { absoluteStamp, relativeTime } from "~/lib/time";
import { notifyError, notifySuccess } from "~/lib/toast";
import {
  noteInstallId,
  setShareCrashReports,
  shareCrashReports,
} from "~/stores/settings-store";

/**
 * Settings -> Diagnostics: the local telemetry log made visible, plus the only
 * two egress affordances the app has — per-event "Report this error" (explicit,
 * previewed, works regardless of the toggle) and the automatic crash scan
 * (governed by the shared `privacy.shareCrashReports` opt-in).
 */

const Card: Component<{
  title: string;
  subtitle?: string;
  action?: JSX.Element;
  children: JSX.Element;
}> = (props) => (
  <div class="glass overflow-hidden rounded-xl">
    <div class="flex items-start justify-between gap-3 border-b border-glass-stroke px-5 py-4">
      <div>
        <div class="text-base font-semibold tracking-tight text-fg-1">
          {props.title}
        </div>
        <Show when={props.subtitle}>
          <div class="mt-0.5 text-sm leading-relaxed text-fg-2">
            {props.subtitle}
          </div>
        </Show>
      </div>
      {props.action}
    </div>
    <div>{props.children}</div>
  </div>
);

const Row: Component<{
  label: string;
  hint?: string;
  children: JSX.Element;
}> = (props) => (
  <div class="flex items-center gap-4 border-t border-glass-stroke px-5 py-3.5 first:border-t-0">
    <div class="min-w-0 flex-1">
      <div class="text-base font-medium text-fg-1">{props.label}</div>
      <Show when={props.hint}>
        <div class="mt-0.5 text-xs leading-relaxed text-fg-3">{props.hint}</div>
      </Show>
    </div>
    <div class="flex-shrink-0">{props.children}</div>
  </div>
);

const copyText = async (text: string, what: string): Promise<void> => {
  try {
    const { writeText } = await import("@tauri-apps/plugin-clipboard-manager");
    await writeText(text);
    notifySuccess(`${what} copied`);
  } catch (e) {
    notifyError("Couldn't copy", describeIpcError(e));
  }
};

const KIND_TINT: Record<string, string> = {
  panic: "var(--color-err)",
  "compile-failed": "var(--color-warn)",
  "lsp-failed": "var(--color-warn)",
};

const KindBadge: Component<{ kind: string }> = (props) => {
  const tint = () => KIND_TINT[props.kind] ?? "var(--color-fg-3)";
  return (
    <span
      class="mono flex-shrink-0 rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide"
      style={{
        color: tint(),
        background: `color-mix(in srgb, ${tint()} 12%, transparent)`,
      }}
    >
      {props.kind}
    </span>
  );
};

const MetaLine: Component<{ label: string; value: string }> = (props) => (
  <div class="flex items-baseline gap-2 text-sm">
    <span class="w-28 flex-shrink-0 text-fg-3">{props.label}</span>
    <span class="mono min-w-0 break-words text-fg-1">{props.value}</span>
  </div>
);

const EventRow: Component<{
  event: ipc.TelemetryEvent;
  onReport: (event: ipc.TelemetryEvent) => void;
}> = (props) => {
  const [expanded, setExpanded] = createSignal(false);
  const time = () => new Date(props.event.at).getTime();
  const copyEvent = () =>
    void copyText(JSON.stringify(props.event, null, 2), "Event");
  return (
    <div class="border-t border-glass-stroke first:border-t-0">
      <div class="flex items-center gap-3 px-5 py-3">
        <button
          type="button"
          onClick={() => setExpanded((v) => !v)}
          disabled={!props.event.detail}
          aria-expanded={expanded()}
          class="lift flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-md text-fg-3 enabled:hover:bg-[var(--color-control-fill)] disabled:opacity-30"
          title={props.event.detail ? "Toggle detail" : "No detail recorded"}
        >
          <Show when={expanded()} fallback={<ChevronRight size={12} />}>
            <ChevronDown size={12} />
          </Show>
        </button>
        <KindBadge kind={props.event.kind} />
        <div class="min-w-0 flex-1">
          <div class="select-text truncate text-sm text-fg-1" title={props.event.summary}>
            {props.event.summary}
          </div>
        </div>
        <span
          class="mono flex-shrink-0 text-xs text-fg-3"
          title={Number.isFinite(time()) ? absoluteStamp(time()) : props.event.at}
        >
          {Number.isFinite(time()) ? relativeTime(time()) : props.event.at}
        </span>
        <div class="flex flex-shrink-0 items-center gap-1">
          <Button
            variant="ghost"
            size="sm"
            class="h-7"
            leadingIcon={<Copy class="ui-icon-sm" />}
            onClick={copyEvent}
          >
            Copy
          </Button>
          <Button
            variant="secondary"
            size="sm"
            class="h-7"
            leadingIcon={<Send class="ui-icon-sm" />}
            onClick={() => props.onReport(props.event)}
          >
            Report
          </Button>
        </div>
      </div>
      <Show when={expanded() && props.event.detail}>
        <pre class="mono scroll mx-5 mb-3 max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-relaxed text-fg-2 glass-inset">
          {props.event.detail}
        </pre>
      </Show>
    </div>
  );
};

export const DiagnosticsPanel: Component = () => {
  // Fetchers swallow into safe fallbacks: a diagnostics IPC hiccup must not
  // blank the Settings screen through the app ErrorBoundary.
  const [events, { refetch }] = createResource(
    () =>
      ipc
        .listRecentTelemetry(200)
        .then((list) => list.slice().reverse())
        .catch(() => [] as ipc.TelemetryEvent[]),
    { initialValue: [] as ipc.TelemetryEvent[] },
  );
  const [info] = createResource(() => ipc.collectSystemInfo().catch(() => null));

  const [reportTarget, setReportTarget] = createSignal<ipc.TelemetryEvent | null>(null);
  const [preview] = createResource(reportTarget, (ev) => ipc.previewErrorReport(ev));
  // Resources keep their previous value while refetching — gate on loading so
  // reopening the dialog for another event never flashes the old payload.
  const previewReady = () => (preview.loading ? undefined : preview());
  const [sending, setSending] = createSignal(false);

  const send = async () => {
    const ev = reportTarget();
    if (!ev || sending()) return;
    setSending(true);
    try {
      const res = await ipc.submitErrorReport(ev);
      noteInstallId(res.installId);
      setReportTarget(null);
      notifySuccess("Report sent", "Thanks — only the previewed payload left this machine.");
    } catch (e) {
      notifyError("Couldn't send the report", describeIpcError(e));
    } finally {
      setSending(false);
    }
  };

  const exportLog = async () => {
    try {
      const content = await ipc.readTelemetryLog();
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        defaultPath: "typeward-telemetry.log",
        filters: [{ name: "Log file", extensions: ["log", "txt"] }],
      });
      if (!dest) return;
      const { writeTextFile } = await import("@tauri-apps/plugin-fs");
      await writeTextFile(dest, content);
      notifySuccess("Log exported");
    } catch (e) {
      notifyError("Couldn't export the log", describeIpcError(e));
    }
  };

  return (
    <div class="space-y-3">
      <Card
        title="System"
        subtitle="What a bug report would say about this machine — no paths, no identifiers."
        action={
          <div class="flex items-center gap-1.5">
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              leadingIcon={<Copy class="ui-icon-sm" />}
              disabled={!info()}
              onClick={() => {
                const i = info();
                if (i) void copyText(formatSystemInfo(i), "System info");
              }}
            >
              Copy
            </Button>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              leadingIcon={<Bug class="ui-icon-sm" />}
              onClick={() => void openBugReport()}
            >
              Report a bug
            </Button>
          </div>
        }
      >
        <div class="px-5 py-4">
          <Show
            when={info()}
            fallback={
              <div class="text-sm text-fg-3">
                {info.loading ? "Collecting system info…" : "System info unavailable."}
              </div>
            }
          >
            {(i) => (
              <pre class="mono select-text whitespace-pre-wrap text-xs leading-relaxed text-fg-2">
                {formatSystemInfo(i())}
              </pre>
            )}
          </Show>
        </div>
      </Card>

      <Card
        title="Crash reporting"
        subtitle="Mirrors Security → Privacy — one setting, shown in both places."
      >
        <Row
          label="Share crash reports"
          hint="When on, crashes from previous runs are reported automatically at launch (at most five, scrubbed exactly like the preview below) and in-app error reporting is enabled. The per-event Report button always works without this — confirming the dialog is your consent for that one event."
        >
          <Switch checked={shareCrashReports()} onChange={setShareCrashReports} />
        </Row>
      </Card>

      <Card
        title="Recent events"
        subtitle="The local diagnostics log (telemetry.log). Capture is always on and never leaves this machine by itself."
        action={
          <div class="flex items-center gap-1.5">
            <Button
              variant="ghost"
              size="sm"
              class="h-8"
              leadingIcon={<RefreshCw class="ui-icon-sm" />}
              onClick={() => void refetch()}
            >
              Refresh
            </Button>
            <Button
              variant="secondary"
              size="sm"
              class="h-8"
              leadingIcon={<Download class="ui-icon-sm" />}
              onClick={() => void exportLog()}
            >
              Export log
            </Button>
          </div>
        }
      >
        <Show
          when={events().length > 0}
          fallback={
            <div class="px-5 py-8 text-center text-sm text-fg-3">
              No events recorded — crashes, compile failures, and LSP errors
              will show up here.
            </div>
          }
        >
          <For each={events()}>
            {(ev) => <EventRow event={ev} onReport={setReportTarget} />}
          </For>
        </Show>
      </Card>

      <Dialog
        open={reportTarget() !== null}
        onOpenChange={(open) => {
          if (!open) setReportTarget(null);
        }}
        title="Report this error"
        description="Exactly this payload is sent to Sentry — nothing else leaves your machine."
        widthClass="w-[560px]"
        footer={
          <>
            <Button
              variant="ghost"
              size="sm"
              class="h-8"
              onClick={() => setReportTarget(null)}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              size="sm"
              class="h-8"
              disabled={sending() || !previewReady()}
              leadingIcon={<Send class="ui-icon-sm" />}
              onClick={() => void send()}
            >
              {sending() ? "Sending…" : "Send report"}
            </Button>
          </>
        }
      >
        <Show
          when={previewReady()}
          fallback={
            <div class="text-sm text-fg-3">
              {preview.error
                ? describeIpcError(preview.error)
                : "Building the scrubbed preview…"}
            </div>
          }
        >
          {(p) => (
            <div class="space-y-3">
              <div class="space-y-1.5">
                <MetaLine label="Kind" value={p().kind} />
                <MetaLine label="Captured" value={p().at} />
                <MetaLine label="App version" value={p().appVersion} />
                <MetaLine label="OS" value={`${p().os} ${p().osVersion} (${p().arch})`} />
                <MetaLine
                  label="Install id"
                  value={p().installId ?? "random id, created on first send"}
                />
              </div>
              <div>
                <div class="label-xs mb-1 text-fg-3">Summary (scrubbed)</div>
                <pre class="mono select-text whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-relaxed text-fg-1 glass-inset">
                  {p().summary}
                </pre>
              </div>
              <Show when={p().detail}>
                <div>
                  <div class="label-xs mb-1 text-fg-3">Detail (scrubbed)</div>
                  <pre class="mono scroll max-h-56 select-text overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-relaxed text-fg-2 glass-inset">
                    {p().detail}
                  </pre>
                </div>
              </Show>
              <div class="text-xs leading-relaxed text-fg-3">
                Paths were scrubbed: your home folder becomes "~" and other
                absolute paths collapse to their file name. No files are
                attached. Sending works even with the crash-report toggle off —
                this confirmation is the consent for this one event.
              </div>
            </div>
          )}
        </Show>
      </Dialog>
    </div>
  );
};
