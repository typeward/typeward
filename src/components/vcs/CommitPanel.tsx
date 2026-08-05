/**
 * Source Control sidebar tab. Lists git status for the active project,
 * stages / unstages files, commits with the user's configured signature,
 * and exposes Pull / Push / Fetch buttons.
 *
 * Status refreshes on a 2s timer while the panel is mounted — that's
 * cheap (one libgit2 stat walk in `git_status`) and matches user
 * expectation that the panel reflects the working tree promptly.
 */

import { describeIpcError } from "~/lib/errors";
import {
  ArrowDown,
  Check,
  ChevronDown,
  ChevronUp,
  GitBranch,
  Minus,
  Plus,
  RefreshCw,
  Send,
} from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createResource, createSignal, onCleanup } from "solid-js";

import { Button } from "~/components/primitives/Button";
import * as ipc from "~/ipc";
import { project } from "~/stores/editor-store";
import { bumpGitState } from "~/stores/git-store";
import { integrationsSettings, profile } from "~/stores/settings-store";

const POLL_INTERVAL_MS = 2_000;

export const CommitPanel: Component = () => {
  const [refreshTick, setRefreshTick] = createSignal(0);
  const [message, setMessage] = createSignal("");
  const [busy, setBusy] = createSignal<"" | "commit" | "push" | "pull" | "fetch" | "init">("");
  const [error, setError] = createSignal<string | null>(null);

  const [status, { refetch }] = createResource(
    () => [project()?.rootPath, refreshTick()] as const,
    async ([rootPath]): Promise<ipc.GitStatusSummary | { kind: "not-a-repo" } | null> => {
      if (!rootPath) return null;
      try {
        const result = await ipc.gitStatus(rootPath);
        // Clear on success: this runs on a 2s heartbeat, so a single transient
        // failure (an index.lock held by a concurrent git command, a brief
        // network hiccup) otherwise left a permanent error banner that no later
        // successful poll could ever retract.
        setError(null);
        return result;
      } catch (err) {
        const msg = describeIpcError(err);
        if (/could not be opened|repository|not.+repo|not\s+found/i.test(msg)) {
          setError(null);
          return { kind: "not-a-repo" };
        }
        setError(msg);
        return null;
      }
    },
  );

  // Heartbeat. Unmounting covers sidebar-tab hiding; the document.hidden
  // guard covers a minimized window, where the panel stays mounted and
  // would otherwise keep walking the worktree every 2s.
  const handle = setInterval(() => {
    if (!document.hidden) setRefreshTick((t) => t + 1);
  }, POLL_INTERVAL_MS);
  onCleanup(() => clearInterval(handle));

  const summary = createMemo<ipc.GitStatusSummary | null>(() => {
    const s = status();
    if (!s) return null;
    if ("kind" in s) return null;
    return s;
  });

  const isNotRepo = createMemo(() => {
    const s = status();
    return s !== null && s !== undefined && "kind" in s && s.kind === "not-a-repo";
  });

  const stagedFiles = createMemo(() =>
    (summary()?.files ?? []).filter((f) => f.staged !== "none"),
  );
  const unstagedFiles = createMemo(() =>
    (summary()?.files ?? []).filter((f) => f.staged === "none" && (f.unstaged !== "none" || f.untracked)),
  );

  // Per field, the explicit git identity wins and the local profile fills the
  // blanks — so a user who only ever filled in Settings -> Profile can commit
  // without configuring the same two values a second time.
  const authorFromSettings = (): ipc.GitAuthor | undefined => {
    const g = integrationsSettings().vcs.git;
    const name = g.authorName?.trim() || profile().displayName.trim();
    const email = g.authorEmail?.trim() || profile().email.trim();
    return name && email ? { name, email } : undefined;
  };

  const wrap = async (kind: typeof busy extends () => infer T ? T : never, fn: () => Promise<void>) => {
    setError(null);
    setBusy(kind);
    try {
      await fn();
      await refetch();
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy("");
    }
  };

  const handleStage = (paths: string[]) =>
    wrap("commit", async () => {
      const proj = project();
      if (!proj) return;
      await ipc.gitStage(proj.rootPath, paths);
    });

  const handleUnstage = (paths: string[]) =>
    wrap("commit", async () => {
      const proj = project();
      if (!proj) return;
      await ipc.gitUnstage(proj.rootPath, paths);
    });

  const handleCommit = () =>
    wrap("commit", async () => {
      const proj = project();
      if (!proj) return;
      if (!message().trim()) {
        throw new Error("Commit message is required.");
      }
      await ipc.gitCommit(proj.rootPath, message().trim(), authorFromSettings());
      setMessage("");
    });

  const handlePush = () =>
    wrap("push", async () => {
      const proj = project();
      if (!proj) return;
      await ipc.gitPush(proj.rootPath);
    });

  const handlePull = () =>
    wrap("pull", async () => {
      const proj = project();
      if (!proj) return;
      await ipc.gitPull(proj.rootPath, undefined, authorFromSettings());
    });

  const handleFetch = () =>
    wrap("fetch", async () => {
      const proj = project();
      if (!proj) return;
      await ipc.gitFetch(proj.rootPath);
    });

  const handleInit = () =>
    wrap("init", async () => {
      const proj = project();
      if (!proj) return;
      await ipc.gitInit(proj.rootPath);
      // Let the sidebar's `.git` probe re-run so the SCM tab reflects the new
      // repo without a project reopen.
      bumpGitState();
    });

  return (
    <div class="flex h-full flex-col">
      <Show
        when={!isNotRepo()}
        fallback={
          <div class="flex flex-1 flex-col items-center justify-center gap-3 px-4 py-8 text-center">
            <GitBranch size={28} class="text-fg-3/60" />
            <div class="text-fg-2">This project isn't a git repo yet.</div>
            <Button variant="primary" size="sm" onClick={handleInit} disabled={busy() === "init"}>
              {busy() === "init" ? "Initializing…" : "git init"}
            </Button>
          </div>
        }
      >
        <BranchHeader summary={summary()} onPush={handlePush} onPull={handlePull} onFetch={handleFetch} busy={busy()} />

        <div class="flex-1 overflow-auto scroll">
          <Show when={stagedFiles().length > 0}>
            <FileSection
              title="Staged"
              files={stagedFiles()}
              actionIcon={<Minus class="ui-icon-sm" />}
              actionLabel="Unstage"
              onAction={(path) => handleUnstage([path])}
            />
          </Show>
          <Show when={unstagedFiles().length > 0}>
            <FileSection
              title="Changes"
              files={unstagedFiles()}
              actionIcon={<Plus class="ui-icon-sm" />}
              actionLabel="Stage"
              onAction={(path) => handleStage([path])}
            />
          </Show>
          <Show when={(summary()?.files.length ?? 0) === 0}>
            <div class="px-4 py-6 text-center text-sm text-fg-3">
              Working tree clean.
            </div>
          </Show>
        </div>

        <div class="flex-shrink-0 border-t border-glass-stroke px-2.5 py-2">
          <textarea
            placeholder="Commit message"
            value={message()}
            onInput={(e) => setMessage(e.currentTarget.value)}
            rows={2}
            class="glass-inset w-full resize-none rounded-md px-2.5 py-1.5 text-sm text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
          <div class="mt-2 flex items-center gap-1.5">
            <Button
              variant="primary"
              size="sm"
              class="flex-1"
              leadingIcon={<Check class="ui-icon-sm" />}
              disabled={
                stagedFiles().length === 0 || !message().trim() || busy() === "commit"
              }
              onClick={handleCommit}
            >
              {busy() === "commit" ? "Committing…" : "Commit"}
            </Button>
          </div>
          <Show when={error()}>
            <div class="mt-2 select-text text-xs text-[var(--color-err)]">{error()}</div>
          </Show>
        </div>
      </Show>
    </div>
  );
};

const BranchHeader: Component<{
  summary: ipc.GitStatusSummary | null;
  busy: string;
  onPush: () => void;
  onPull: () => void;
  onFetch: () => void;
}> = (props) => (
  <div class="flex flex-shrink-0 items-center gap-2 border-b border-glass-stroke px-2.5 py-2">
    <GitBranch class="ui-icon-sm text-fg-3" />
    <span class="mono text-sm text-fg-1">
      {props.summary?.branch ?? "(detached)"}
    </span>
    <Show when={props.summary?.upstream}>
      <span class="ml-1 flex items-center gap-1 text-[10px] text-fg-3">
        <Show when={(props.summary?.ahead ?? 0) > 0}>
          <ChevronUp class="ui-icon-sm" />
          <span>{props.summary?.ahead}</span>
        </Show>
        <Show when={(props.summary?.behind ?? 0) > 0}>
          <ChevronDown class="ui-icon-sm" />
          <span>{props.summary?.behind}</span>
        </Show>
      </span>
    </Show>
    <div class="ml-auto flex items-center gap-1">
      <Button
        variant="ghost"
        size="sm"
        aria-label="Fetch"
        onClick={props.onFetch}
        disabled={props.busy === "fetch"}
      >
        <RefreshCw class="ui-icon-sm" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Pull"
        onClick={props.onPull}
        disabled={props.busy === "pull"}
      >
        <ArrowDown class="ui-icon-sm" />
      </Button>
      <Button
        variant="ghost"
        size="sm"
        aria-label="Push"
        onClick={props.onPush}
        disabled={props.busy === "push"}
      >
        <Send class="ui-icon-sm" />
      </Button>
    </div>
  </div>
);

const FileSection: Component<{
  title: string;
  files: ipc.GitFileStatus[];
  actionIcon: import("solid-js").JSX.Element;
  actionLabel: string;
  onAction: (path: string) => void;
}> = (props) => (
  <div class="border-b border-glass-stroke">
    <div class="label-xs flex items-center gap-2 bg-[var(--color-control-fill)]/50 px-3 py-1.5 text-fg-3">
      <span>{props.title}</span>
      <span class="mono ml-auto text-fg-3">{props.files.length}</span>
    </div>
    <For each={props.files}>
      {(file) => (
        <div class="flex items-center gap-2 border-t border-glass-stroke/40 px-3 py-1.5">
          <ChangeKindBadge
            kind={
              file.staged !== "none"
                ? file.staged
                : file.untracked
                  ? "added"
                  : file.unstaged
            }
            untracked={file.untracked}
          />
          <span class="mono select-text truncate text-sm text-fg-1">{file.path}</span>
          <button
            type="button"
            class="lift ml-auto rounded p-1 text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
            aria-label={`${props.actionLabel} ${file.path}`}
            onClick={() => props.onAction(file.path)}
          >
            {props.actionIcon}
          </button>
        </div>
      )}
    </For>
  </div>
);

const KIND_LABEL: Record<ipc.GitChangeKind, string> = {
  added: "A",
  modified: "M",
  deleted: "D",
  renamed: "R",
  typechange: "T",
  none: "",
};

const KIND_COLOR: Record<ipc.GitChangeKind, string> = {
  added: "var(--color-ok)",
  modified: "var(--color-warn)",
  deleted: "var(--color-err)",
  renamed: "var(--color-accent-2)",
  typechange: "var(--color-warn)",
  none: "var(--color-fg-3)",
};

const ChangeKindBadge: Component<{ kind: ipc.GitChangeKind; untracked: boolean }> = (props) => (
  <span
    class="mono inline-flex h-4 w-4 items-center justify-center rounded text-[10px] font-semibold"
    style={{
      color: KIND_COLOR[props.kind],
      background: `color-mix(in srgb, ${KIND_COLOR[props.kind]} 13%, transparent)`,
    }}
    title={props.untracked ? "Untracked" : props.kind}
  >
    {props.untracked ? "U" : KIND_LABEL[props.kind]}
  </span>
);
