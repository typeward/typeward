/**
 * Git-clone modal: URL + project name, nothing else. Authentication is the
 * user's own git setup — libgit2 asks the configured credential helper (Git
 * Credential Manager, osxkeychain, …), so private repos need no in-app
 * sign-in; a token can also ride in the URL itself.
 *
 * Clone destination is `<projectsRoot>/<sanitized-name>/` — same place
 * `create()` puts a fresh local project, just with the cloned tree
 * filling it.
 */

import { describeIpcError } from "~/lib/errors";
import type { Component } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";

import { TextField } from "~/components/forms/TextField";
import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import * as ipc from "~/ipc";
import { refresh as refreshProjects } from "~/stores/projects-store";
import { projectsRoot } from "~/stores/settings-store";

interface CloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned?: (destPath: string) => void;
}

export const CloneDialog: Component<CloneDialogProps> = (props) => {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const inferredName = createMemo(() => {
    if (name().trim()) return name().trim();
    const u = url().trim();
    const match = u.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : "";
  });

  const reset = () => {
    setUrl("");
    setName("");
    setError(null);
    setBusy(false);
  };

  const handleClone = async () => {
    setError(null);
    const u = url().trim();
    const projRoot = projectsRoot();
    if (!u || !projRoot) {
      setError("Paste a repository URL first.");
      return;
    }
    const destName = inferredName();
    if (!destName) {
      setError("Could not derive a project name from the URL. Fill in Name.");
      return;
    }
    setBusy(true);
    try {
      const destPath = joinPath(projRoot, sanitize(destName));
      await ipc.gitClone(u, destPath);
      // A plain git repo has no .typeward/project.json, so list_projects would
      // never surface it. Detect the root file and write project metadata so
      // the clone appears in the library and opens.
      try {
        await ipc.importProjectFolder(destPath);
      } catch {
        await refreshProjects();
        setError(
          `Cloned to ${destPath}, but no LaTeX/Typst entry was found. Add a main.tex/main.typ, then open the folder.`,
        );
        setBusy(false);
        return;
      }
      await refreshProjects();
      reset();
      props.onCloned?.(destPath);
      props.onOpenChange(false);
    } catch (err) {
      setError(describeIpcError(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={props.open}
      onOpenChange={(open) => {
        if (!open) reset();
        props.onOpenChange(open);
      }}
      title="Clone repository"
      description="Paste an HTTPS git URL: GitHub, Overleaf git-bridge, GitLab, any host."
      widthClass="w-[560px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Cancel
          </Button>
          <Button variant="primary" disabled={busy() || !url().trim()} onClick={handleClone}>
            {busy() ? "Cloning…" : "Clone"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <TextField
          label="URL"
          type="text"
          value={url()}
          onInput={(e) => setUrl(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing && !busy() && url().trim()) void handleClone();
          }}
          placeholder="https://github.com/typeward/typeward.git"
          autofocus
        />

        <TextField
          label="Project name"
          type="text"
          value={name()}
          onInput={(e) => setName(e.currentTarget.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing && !busy() && url().trim()) void handleClone();
          }}
          placeholder={inferredName() || "my-thesis"}
        />

        <div class="text-xs text-fg-3">
          Private repos authenticate through your git credential helper (Git
          Credential Manager, osxkeychain, …), or embed a token in the URL,
          e.g. Overleaf's git bridge: https://git:TOKEN@git.overleaf.com/…
        </div>

        <Show when={error()}>
          <div class="select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]">
            {error()}
          </div>
        </Show>
      </div>
    </Dialog>
  );
};

function sanitize(name: string): string {
  return (
    name
      .split("")
      .map((c) => (/[A-Za-z0-9_\-]/.test(c) ? c : "-"))
      .join("")
      .replace(/-+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

function joinPath(root: string, rel: string): string {
  const sep = root.includes("\\") ? "\\" : "/";
  const trimmed = root.replace(/[\\/]+$/, "");
  return `${trimmed}${sep}${rel}`;
}
