import { describeIpcError } from "~/lib/errors";
import { Save } from "lucide-solid";
import type { Component } from "solid-js";
import { createEffect, createSignal, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { hasEntitlement } from "~/integrations/entitlements";
import { requestSaveTemplate_, setRequestSaveTemplate } from "~/commands/palette-store";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";
import { project } from "~/stores/editor-store";

/**
 * Captures the open project as a reusable custom template. Mounted once at the
 * App root; opened by the "Save project as template" command via the
 * `requestSaveTemplate` signal.
 */
export const SaveTemplateDialog: Component = () => {
  const [name, setName] = createSignal("");
  const [description, setDescription] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  // Seed the name from the current project each time the dialog opens.
  createEffect(() => {
    if (requestSaveTemplate_()) {
      const p = project();
      setName(p?.name ?? "");
      setDescription("");
      setError(null);
      setSuccess(null);
      setBusy(false);
    }
  });

  const close = () => setRequestSaveTemplate(false);

  const handleSave = async () => {
    setError(null);
    setSuccess(null);
    const p = project();
    if (!p) {
      setError("Open a project first.");
      return;
    }
    if (!hasEntitlement("templates.custom.max")) {
      setError("Custom templates require Typeward Pro.");
      return;
    }
    if (!name().trim()) {
      setError("Give the template a name.");
      return;
    }

    setBusy(true);
    try {
      const manifest = await ipc.templateSave(p, name().trim(), description().trim());
      setSuccess(`Saved "${manifest.name}" — it now appears under Custom in the template gallery.`);
    } catch (err) {
      const message = describeIpcError(err);
      // A duplicate id is the common, expected failure — keep it actionable.
      setError(
        /already exists/i.test(message)
          ? "A custom template with this name already exists. Pick a different name."
          : message,
      );
      recordError("template-save", "template_save IPC failed", err);
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open={requestSaveTemplate_()}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Save project as template"
      description="Capture the current project's files as a reusable custom template. Build output and .typeward/.git metadata are excluded."
      widthClass="w-[520px]"
      footer={
        <>
          <Button variant="ghost" onClick={close}>
            {success() ? "Done" : "Cancel"}
          </Button>
          <Show when={!success()}>
            <Button
              variant="primary"
              leadingIcon={<Save class="ui-icon-sm" />}
              disabled={busy() || !name().trim()}
              onClick={handleSave}
            >
              {busy() ? "Saving…" : "Save template"}
            </Button>
          </Show>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <label class="flex flex-col gap-1">
          <span class="text-sm text-fg-2">Name</span>
          <input
            type="text"
            value={name()}
            onInput={(e) => setName(e.currentTarget.value)}
            placeholder="My thesis template"
            class="glass-inset h-10 w-full rounded-md px-3 text-base text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
            autofocus
            onKeyDown={(e) => {
              if (e.key === "Enter" && !e.isComposing && !busy() && name().trim()) handleSave();
            }}
          />
        </label>
        <label class="flex flex-col gap-1">
          <span class="text-sm text-fg-2">Description (optional)</span>
          <textarea
            value={description()}
            onInput={(e) => setDescription(e.currentTarget.value)}
            placeholder="What this template is for."
            rows={2}
            class="glass-inset w-full resize-none rounded-md px-3 py-2 text-base text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          />
        </label>

        <Show when={error()}>
          <div class="select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]">
            {error()}
          </div>
        </Show>
        <Show when={success()}>
          <div class="select-text rounded-md border border-[var(--color-ok)]/40 bg-[var(--color-ok)]/10 px-3 py-2 text-sm text-[var(--color-ok)]">
            {success()}
          </div>
        </Show>
      </div>
    </Dialog>
  );
};
