import { describeIpcError } from "~/lib/errors";
import { Plus } from "lucide-solid";
import type { Component } from "solid-js";
import { createSignal, Show } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { hasEntitlement } from "~/integrations/entitlements";
import { refreshLibraryBib } from "~/integrations/references/aggregator";
import {
  appendLocalAddition,
  classifyLookupInput,
  lookupCitation,
} from "~/integrations/references/doi-lookup";
import { project } from "~/stores/editor-store";

interface DoiLookupDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Optional callback fired after a successful add — typically refreshes the panel. */
  onAdded?: (key: string) => void;
}

export const DoiLookupDialog: Component<DoiLookupDialogProps> = (props) => {
  const [input, setInput] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  const [success, setSuccess] = createSignal<string | null>(null);

  const reset = () => {
    setInput("");
    setBusy(false);
    setError(null);
    setSuccess(null);
  };

  const handleAdd = async () => {
    setError(null);
    setSuccess(null);
    const proj = project();
    if (!proj) {
      setError("Open a project first.");
      return;
    }
    if (!hasEntitlement("integrations.references.doi_lookup")) {
      setError("DOI and arXiv lookup requires Typeward Pro.");
      return;
    }
    const classified = classifyLookupInput(input());
    if (classified.kind === "unknown") {
      setError(
        "Couldn't parse that as a DOI or arXiv id. Try 10.1145/3290605.3300479 or 2403.04132.",
      );
      return;
    }

    setBusy(true);
    try {
      const result = await lookupCitation(input());
      const added = await appendLocalAddition(proj, result.bibtex);
      await refreshLibraryBib(proj);
      props.onAdded?.(added.key);
      setSuccess(
        added.added
          ? `Added ${added.key}.`
          : `${added.key} was already in the project library.`,
      );
      setInput("");
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
      title="Add citation from DOI or arXiv"
      description="Paste a DOI, an arXiv id, or a URL to either. We fetch the BibTeX and append it to this project."
      widthClass="w-[520px]"
      footer={
        <>
          <Button variant="ghost" onClick={() => props.onOpenChange(false)}>
            Close
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Plus class="ui-icon-sm" />}
            disabled={busy() || !input().trim()}
            onClick={handleAdd}
          >
            {busy() ? "Fetching…" : "Add"}
          </Button>
        </>
      }
    >
      <div class="flex flex-col gap-3">
        <input
          type="text"
          value={input()}
          onInput={(e) => setInput(e.currentTarget.value)}
          placeholder="10.1145/3290605.3300479 or 2403.04132"
          class="glass-inset h-10 w-full rounded-md px-3 text-base text-fg-1 placeholder:text-fg-2 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
          autofocus
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.isComposing && !busy()) handleAdd();
          }}
        />

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
