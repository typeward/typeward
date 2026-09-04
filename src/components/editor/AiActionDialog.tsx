import { writeText } from "@tauri-apps/plugin-clipboard-manager";
import { Check, Copy, Loader2, Square } from "lucide-solid";
import type { Component } from "solid-js";
import {
  Show,
  createEffect,
  createSignal,
  on,
  onCleanup,
} from "solid-js";

import {
  requestAiAction_,
  setRequestAiAction,
  type AiActionRequestInfo,
} from "~/commands/palette-store";
import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { mountHistoryDiff } from "~/components/editor/history-diff";
import { activeProvider } from "~/integrations/ai/registry";
import { describeIpcError } from "~/lib/errors";
import { notifyError, notifySuccess } from "~/lib/toast";
import { resolveSelectedModel } from "~/stores/ai-chat-store";
import {
  getActiveEditorView,
  insertAtCursor,
  replaceRange,
} from "~/stores/editor-view-store";
import { integrationsSettings } from "~/stores/settings-store";

/**
 * Streaming preview for the transform/continue AI editor actions. Lazy-mounted
 * at the App root (SaveTemplateDialog pattern); a request from `runAiAction`
 * opens it, streams the provider's reply, then shows a read-only unified diff
 * of selection → result (via `@codemirror/merge`, dynamic-imported through
 * `mountHistoryDiff`) with Replace / Insert / Copy apply mechanics.
 *
 * Stale-selection guard: the request carries `{from, to, text}` captured at
 * invoke; Replace verifies `doc.sliceString(from, to) === text` and disables
 * itself on mismatch — Insert and Copy stay live.
 */
export const AiActionDialog: Component = () => {
  const [result, setResult] = createSignal("");
  const [streaming, setStreaming] = createSignal(false);
  const [error, setError] = createSignal<string | null>(null);
  // Bumped when the doc may have changed under the dialog; Replace re-derives.
  const [staleCheck, setStaleCheck] = createSignal(0);

  let abortController: AbortController | null = null;
  let diffHost: HTMLDivElement | undefined;
  let unmountDiff: (() => void) | null = null;

  const request = requestAiAction_;
  const open = () => request() !== null;

  const close = () => {
    abortController?.abort();
    setRequestAiAction(null);
  };

  const destroyDiff = () => {
    unmountDiff?.();
    unmountDiff = null;
    if (diffHost) diffHost.innerHTML = "";
  };

  const selectionValid = (): boolean => {
    staleCheck();
    const req = request();
    const view = getActiveEditorView();
    if (!req || !view) return false;
    const { from, to, text } = req.snapshot;
    if (to > view.state.doc.length) return false;
    return view.state.doc.sliceString(from, to) === text;
  };

  function mountDiff(req: AiActionRequestInfo, text: string): void {
    if (req.kind !== "transform" || text.length === 0 || !diffHost) return;
    void mountHistoryDiff(diffHost, req.snapshot.text, text).then((dispose) => {
      // A newer request may have started while the merge chunk loaded.
      if (request()?.generation === req.generation) {
        unmountDiff = dispose;
      } else {
        dispose();
      }
    });
  }

  async function stream(req: AiActionRequestInfo): Promise<void> {
    // A palette shortcut can fire over the open dialog — abort the superseded
    // stream before claiming the slot (the signal propagates to
    // ai_stream_abort), or its Rust task and provider request run to
    // completion with no consumer.
    abortController?.abort();
    abortController = null;
    destroyDiff();
    // Chat-bubble "Apply to selection" arrives final — no request to send.
    if (req.presetResult !== undefined) {
      setError(null);
      setStreaming(false);
      setResult(req.presetResult);
      setStaleCheck((n) => n + 1);
      mountDiff(req, req.presetResult);
      return;
    }
    setResult("");
    setError(null);
    setStreaming(true);
    const controller = new AbortController();
    abortController = controller;
    let acc = "";
    try {
      const prov = activeProvider(integrationsSettings().ai.ollamaBaseUrl);
      if (!prov) {
        throw new Error(
          "No AI provider active. Pick one in Settings → Integrations → AI.",
        );
      }
      const model = await resolveSelectedModel(prov);
      if (!model) {
        throw new Error(
          "No model available; the provider may be unreachable. Check Settings → Integrations → AI.",
        );
      }
      // Only model + messages — no temperature/maxTokens (the o-series
      // rejects both; provider defaults are fine).
      for await (const chunk of prov.chat(req.messages, {
        model,
        signal: controller.signal,
      })) {
        if (request()?.generation !== req.generation) return;
        if (chunk.delta) {
          acc += chunk.delta;
          setResult(acc);
        }
        if (chunk.done) break;
      }
    } catch (e) {
      if (request()?.generation === req.generation) {
        setError(describeIpcError(e));
      }
    } finally {
      if (request()?.generation === req.generation) {
        setStreaming(false);
        setStaleCheck((n) => n + 1);
        abortController = null;
        mountDiff(req, acc);
      }
    }
  }

  createEffect(
    on(
      () => request()?.generation,
      (generation) => {
        if (generation === undefined) return;
        const req = request();
        if (req) void stream(req);
      },
    ),
  );

  onCleanup(() => {
    abortController?.abort();
    destroyDiff();
  });

  const applyReplace = () => {
    const req = request();
    if (!req || !selectionValid() || !result()) return;
    replaceRange(req.snapshot.from, req.snapshot.to, result());
    close();
  };

  const applyInsert = () => {
    const req = request();
    if (!req || !result()) return;
    if (req.kind === "transform") {
      const view = getActiveEditorView();
      const at = Math.min(req.snapshot.to, view?.state.doc.length ?? req.snapshot.to);
      replaceRange(at, at, `\n${result()}`);
    } else {
      insertAtCursor(result());
    }
    close();
  };

  const copyResult = async () => {
    try {
      await writeText(result());
      notifySuccess("Copied");
    } catch (e) {
      notifyError("Couldn't copy", describeIpcError(e));
    }
  };

  return (
    <Dialog
      open={open()}
      onOpenChange={(v) => {
        if (!v) close();
      }}
      title={request()?.label ?? "AI"}
      description={
        request()?.kind === "transform"
          ? "Review the change, then replace the selection or insert below it."
          : "Review the draft, then insert it at the cursor."
      }
      widthClass="w-[640px]"
      footer={
        <>
          <Show when={streaming()}>
            <Button
              variant="danger"
              size="compact"
              class="rounded-lg font-semibold"
              onClick={() => abortController?.abort()}
              leadingIcon={<Square size={12} stroke-width={2.2} />}
            >
              Stop
            </Button>
          </Show>
          <Show when={!streaming() && result().length > 0}>
            <Button
              size="compact"
              class="rounded-lg"
              onClick={() => void copyResult()}
              leadingIcon={<Copy size={12} />}
            >
              Copy
            </Button>
            <Button size="compact" class="rounded-lg" onClick={applyInsert}>
              {request()?.kind === "transform" ? "Insert below" : "Insert at cursor"}
            </Button>
            <Show when={request()?.kind === "transform"}>
              <Button
                variant="primary"
                size="compact"
                class="rounded-lg font-semibold"
                disabled={!selectionValid()}
                title={
                  selectionValid()
                    ? undefined
                    : "The selection changed since this action started. Use Insert or Copy."
                }
                onClick={applyReplace}
                leadingIcon={<Check size={12} stroke-width={2.2} />}
              >
                Replace
              </Button>
            </Show>
          </Show>
        </>
      }
    >
      <div class="flex min-h-[160px] flex-col gap-3">
        <Show when={streaming()}>
          <div class="flex items-center gap-2 text-sm text-fg-3">
            <Loader2 size={13} class="animate-spin" />
            Generating…
          </div>
          <div
            class="mono select-text whitespace-pre-wrap rounded-md p-3 text-sm leading-relaxed text-fg-1 glass-inset max-h-[300px] overflow-auto scroll"
          >
            {result() || "…"}
          </div>
        </Show>

        <Show when={!streaming() && request()?.kind === "continue" && result()}>
          <div class="mono select-text whitespace-pre-wrap rounded-md p-3 text-sm leading-relaxed text-fg-1 glass-inset max-h-[380px] overflow-auto scroll">
            {result()}
          </div>
        </Show>

        {/* The unified diff mounts here after a transform completes. */}
        <div
          ref={diffHost}
          class="glass-inset overflow-auto scroll rounded-md"
          classList={{
            hidden: streaming() || request()?.kind !== "transform" || !result(),
          }}
          style={{ "max-height": "380px" }}
        />

        <Show when={!streaming() && !result() && !error()}>
          <div class="text-sm text-fg-3">Nothing came back from the provider.</div>
        </Show>

        <Show when={error()}>
          <div
            role="alert"
            class="select-text rounded-md border border-[var(--color-err)]/40 bg-[var(--color-err)]/10 px-3 py-2 text-sm text-[var(--color-err)]"
          >
            {error()}
          </div>
        </Show>
      </div>
    </Dialog>
  );
};

export default AiActionDialog;
