/**
 * Template gallery + variable form, packaged as a single dialog so the
 * caller (NewProjectDialog) doesn't manage the two-step flow.
 *
 * Two stages internally:
 *   1. Grid of cards filtered by format + tag. Click selects.
 *   2. Variable form for the manifest's `variables`, plus a name input.
 *      Submit dispatches `templateInstantiate` and resolves with the
 *      created Project.
 */

import { ChevronLeft, FileText, Search } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createResource, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import * as ipc from "~/ipc";
import type { Project } from "~/adapters/types";
import { projectsRoot } from "~/stores/settings-store";

interface TemplateGalleryProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreated: (project: Project) => void;
}

export const TemplateGallery: Component<TemplateGalleryProps> = (props) => {
  const [search, setSearch] = createSignal("");
  const [selected, setSelected] = createSignal<ipc.TemplateManifest | null>(null);
  const [name, setName] = createSignal("");
  const [vars, setVars] = createSignal<Record<string, string>>({});
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);

  const [templates] = createResource(
    () => props.open,
    async (isOpen) => {
      if (!isOpen) return [] as ipc.TemplateManifest[];
      return await ipc.templatesList();
    },
    { initialValue: [] },
  );

  const filtered = createMemo(() => {
    const q = search().trim().toLowerCase();
    if (!q) return templates() ?? [];
    return (templates() ?? []).filter((t) => {
      const hay = [t.name, t.description, ...t.tags, t.format].join(" ").toLowerCase();
      return hay.includes(q);
    });
  });

  const reset = () => {
    setSearch("");
    setSelected(null);
    setName("");
    setVars({});
    setError(null);
    setBusy(false);
  };

  const handleSelect = (template: ipc.TemplateManifest) => {
    setSelected(template);
    setName(template.name);
    setVars(
      Object.fromEntries(template.variables.map((v) => [v.key, v.default ?? ""])),
    );
  };

  const handleInstantiate = async () => {
    const template = selected();
    const dest = projectsRoot();
    if (!template || !dest) return;
    if (!name().trim()) {
      setError("Name is required.");
      return;
    }
    setError(null);
    setBusy(true);
    try {
      const project = await ipc.templateInstantiate(template.id, dest, name().trim(), vars());
      reset();
      props.onCreated(project);
      props.onOpenChange(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
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
      title={selected() ? `New project from ${selected()!.name}` : "Pick a template"}
      description={
        selected()
          ? "Fill in the variables — these substitute into the starter files at create time."
          : "Built-in templates ship with the app. Custom templates live under your app data directory."
      }
      widthClass="w-[680px]"
      footer={
        <Show
          when={selected()}
          fallback={
            <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
              Cancel
            </Button>
          }
        >
          <>
            <Button
              variant="ghost"
              leadingIcon={<ChevronLeft class="ui-icon-sm" />}
              onClick={() => setSelected(null)}
            >
              Back
            </Button>
            <Button variant="primary" disabled={busy()} onClick={handleInstantiate}>
              {busy() ? "Creating…" : "Create"}
            </Button>
          </>
        </Show>
      }
    >
      <Show
        when={selected()}
        fallback={
          <GalleryGrid
            templates={filtered() ?? []}
            search={search()}
            onSearchChange={setSearch}
            onSelect={handleSelect}
          />
        }
      >
        <VariableForm
          template={selected()!}
          name={name()}
          onNameChange={setName}
          vars={vars()}
          onVarChange={(key, value) => setVars({ ...vars(), [key]: value })}
          error={error()}
        />
      </Show>
    </Dialog>
  );
};

const GalleryGrid: Component<{
  templates: ipc.TemplateManifest[];
  search: string;
  onSearchChange: (q: string) => void;
  onSelect: (t: ipc.TemplateManifest) => void;
}> = (props) => (
  <div class="flex flex-col gap-3">
    <div class="glass-inset flex h-9 items-center gap-2 rounded-md px-3 focus-within:ring-1 focus-within:ring-[var(--color-accent-1)]">
      <Search class="ui-icon-sm text-fg-3" />
      <input
        type="search"
        placeholder="Filter by name, format, or tag…"
        value={props.search}
        onInput={(e) => props.onSearchChange(e.currentTarget.value)}
        class="h-full flex-1 bg-transparent text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-3 outline-none"
        autofocus
      />
    </div>
    <Show
      when={props.templates.length > 0}
      fallback={
        <div class="py-8 text-center text-[length:var(--ui-font-sm)] text-fg-3">
          No matching templates.
        </div>
      }
    >
      <div class="grid grid-cols-2 gap-2">
        <For each={props.templates}>
          {(t) => (
            <button
              type="button"
              onClick={() => props.onSelect(t)}
              class="lift glass-inset flex flex-col items-start gap-1 rounded-lg border border-glass-stroke p-3 text-left hover:border-[var(--color-accent-1)]/40 hover:bg-[var(--color-control-fill)]"
            >
              <div class="flex w-full items-center gap-2">
                <FileText class="ui-icon-sm text-fg-3" />
                <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
                  {t.name}
                </span>
                <span
                  class="mono ml-auto rounded-full px-1.5 py-0.5 text-[10px] uppercase tracking-wider"
                  style={{
                    background: "var(--color-control-fill)",
                    color: "var(--color-fg-3)",
                  }}
                >
                  {t.format}
                </span>
              </div>
              <Show when={t.description}>
                <p class="line-clamp-2 text-[11px] leading-relaxed text-fg-3">
                  {t.description}
                </p>
              </Show>
              <Show when={t.tags.length > 0}>
                <div class="flex flex-wrap gap-1">
                  <For each={t.tags}>
                    {(tag) => (
                      <span class="mono rounded-full bg-[var(--color-control-fill)] px-1.5 py-0.5 text-[10px] text-fg-3">
                        {tag}
                      </span>
                    )}
                  </For>
                </div>
              </Show>
            </button>
          )}
        </For>
      </div>
    </Show>
  </div>
);

const VariableForm: Component<{
  template: ipc.TemplateManifest;
  name: string;
  onNameChange: (v: string) => void;
  vars: Record<string, string>;
  onVarChange: (key: string, value: string) => void;
  error: string | null;
}> = (props) => (
  <div class="flex flex-col gap-3">
    <label class="flex flex-col gap-1">
      <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-2">
        Project name
      </span>
      <input
        type="text"
        value={props.name}
        onInput={(e) => props.onNameChange(e.currentTarget.value)}
        class="glass-inset h-9 rounded-md px-2.5 text-[length:var(--ui-font-sm)] text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
      />
    </label>

    <For each={props.template.variables}>
      {(variable) => (
        <label class="flex flex-col gap-1">
          <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-2">
            {variable.label}
          </span>
          <Show
            when={variable.multiline}
            fallback={
              <input
                type="text"
                value={props.vars[variable.key] ?? ""}
                onInput={(e) => props.onVarChange(variable.key, e.currentTarget.value)}
                class="glass-inset h-9 rounded-md px-2.5 text-[length:var(--ui-font-sm)] text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
              />
            }
          >
            <textarea
              value={props.vars[variable.key] ?? ""}
              onInput={(e) => props.onVarChange(variable.key, e.currentTarget.value)}
              rows={3}
              class="glass-inset resize-none rounded-md px-2.5 py-2 text-[length:var(--ui-font-sm)] text-fg-1 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
            />
          </Show>
        </label>
      )}
    </For>

    <Show when={props.error}>
      <div class="text-[length:var(--ui-font-sm)] text-[var(--color-err)]">
        {props.error}
      </div>
    </Show>
  </div>
);
