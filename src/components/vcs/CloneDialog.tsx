/**
 * Generic git-clone modal. Pasted URLs are sniffed: GitHub URLs offer
 * a one-click sign-in if the user hasn't connected GitHub yet; Overleaf
 * URLs surface an email + project-token form pre-filled with the
 * Overleaf credential slot. Any other URL falls back to a generic
 * user/password pair that lands in `git.<host>` in the keyring.
 *
 * Clone destination is `<projectsRoot>/<sanitized-name>/` — same place
 * `create()` puts a fresh local project, just with the cloned tree
 * filling it.
 */

import { describeIpcError } from "~/lib/errors";
import { GitBranch } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createMemo, createSignal } from "solid-js";

import { TextField } from "~/components/forms/TextField";
import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { setCredential } from "~/integrations/auth/credentials";
import {
  connectGithub,
  hasGithubCredential,
} from "~/integrations/vcs/github";
import * as ipc from "~/ipc";
import { refresh as refreshProjects } from "~/stores/projects-store";
import { projectsRoot } from "~/stores/settings-store";

interface CloneDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloned?: (destPath: string) => void;
}

type Kind = "github" | "overleaf" | "generic";

export const CloneDialog: Component<CloneDialogProps> = (props) => {
  const [url, setUrl] = createSignal("");
  const [name, setName] = createSignal("");
  const [username, setUsername] = createSignal("");
  const [password, setPassword] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const kind = createMemo<Kind>(() => {
    const u = url();
    // GitHub only — GitLab must NOT match here or its users get blocked
    // behind the GitHub device-flow sign-in. GitLab goes through the
    // generic username/PAT path.
    if (/^https:\/\/github\.com\//i.test(u)) return "github";
    if (/^https:\/\/git\.overleaf\.com\//i.test(u)) return "overleaf";
    return "generic";
  });

  const hostFromUrl = createMemo(() => {
    try {
      return new URL(url()).host;
    } catch {
      return null;
    }
  });

  const inferredName = createMemo(() => {
    if (name().trim()) return name().trim();
    const u = url().trim();
    const match = u.match(/\/([^/]+?)(?:\.git)?$/);
    return match ? match[1] : "";
  });

  const reset = () => {
    setUrl("");
    setName("");
    setUsername("");
    setPassword("");
    setError(null);
    setBusy(false);
  };

  const connectGithubInline = async () => {
    setError(null);
    try {
      await connectGithub();
    } catch (err) {
      setError(describeIpcError(err));
    }
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
      setError("Could not derive a project name from the URL — fill in Name.");
      return;
    }
    setBusy(true);
    try {
      // Stash credentials before triggering the clone so libgit2's
      // callback can find them.
      const host = hostFromUrl();
      if (kind() === "overleaf") {
        if (!username().trim() || !password().trim()) {
          throw new Error("Overleaf needs your account email + a project-specific token.");
        }
        await setCredential(
          { service: `git.${host ?? "git.overleaf.com"}`, account: username().trim() },
          password().trim(),
        );
      } else if (kind() === "github") {
        if (!(await hasGithubCredential())) {
          throw new Error("Sign in to GitHub first — the button above opens the device flow.");
        }
      } else if (username().trim() && password().trim()) {
        if (!host) throw new Error("Could not parse host from the URL.");
        await setCredential(
          { service: `git.${host}`, account: username().trim() },
          password().trim(),
        );
      }

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
          `Cloned to ${destPath}, but no LaTeX/Typst entry was found — add a main.tex/main.typ, then open the folder.`,
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
      description="Paste a git URL — GitHub, Overleaf git-bridge, or any HTTPS-served repo."
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
          placeholder="https://github.com/typeward/app.git"
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

        <Show when={kind() === "github"}>
          <div class="glass-inset flex items-center gap-2 rounded-md px-2.5 py-2">
            <GitBranch class="ui-icon-sm text-fg-3" />
            <div class="flex-1 text-xs text-fg-2">
              GitHub clones go through your signed-in account. Sign in once and Typeward stores the token in the system keyring.
            </div>
            <Button variant="secondary" size="sm" onClick={connectGithubInline}>
              Sign in
            </Button>
          </div>
        </Show>

        <Show when={kind() === "overleaf"}>
          <div class="flex flex-col gap-2">
            <div class="glass-inset flex items-center gap-2 rounded-md px-2.5 py-2 text-xs text-fg-2">
              <GitBranch class="ui-icon-sm text-fg-3" />
              Overleaf's git bridge is a premium feature. Paste your account email + the project-specific token from Overleaf's Project → Git → Generate token.
            </div>
            <TextField
              label="Email (Overleaf account)"
              hideLabel
              type="text"
              placeholder="Email (Overleaf account)"
              value={username()}
              onInput={(e) => setUsername(e.currentTarget.value)}
            />
            <TextField
              label="Project token"
              hideLabel
              mono
              type="password"
              placeholder="Project token"
              value={password()}
              onInput={(e) => setPassword(e.currentTarget.value)}
            />
          </div>
        </Show>

        <Show when={kind() === "generic"}>
          <div class="flex flex-col gap-2">
            <div class="text-xs text-fg-3">
              Optional. Leave blank for public repos; fill for any HTTPS repo that needs basic auth or a personal access token.
            </div>
            <div class="flex gap-2">
              <div class="min-w-0 flex-1">
                <TextField
                  label="Username (optional)"
                  hideLabel
                  type="text"
                  placeholder="Username (optional)"
                  value={username()}
                  onInput={(e) => setUsername(e.currentTarget.value)}
                />
              </div>
              <div class="min-w-0 flex-1">
                <TextField
                  label="Password / token (optional)"
                  hideLabel
                  mono
                  type="password"
                  placeholder="Password / token (optional)"
                  value={password()}
                  onInput={(e) => setPassword(e.currentTarget.value)}
                />
              </div>
            </div>
          </div>
        </Show>

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
