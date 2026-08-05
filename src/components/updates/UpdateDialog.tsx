import { Download } from "lucide-solid";
import type { Component } from "solid-js";
import { Show, createSignal } from "solid-js";

import { Button } from "~/components/primitives/Button";
import { Dialog } from "~/components/primitives/Dialog";
import { describeIpcError } from "~/lib/errors";
import { notifyError } from "~/lib/toast";
import { installPendingUpdate, type InstallProgress } from "~/lib/updater";
import {
  requestUpdateDialog_,
  setRequestUpdateDialog,
} from "~/commands/palette-store";

/**
 * "Update available" dialog. Non-modal by policy (privacy brand — prompt,
 * never silent-install): lazy-mounted once at the App root and driven by the
 * `requestUpdateDialog` signal, same pattern as SaveTemplateDialog. Release
 * notes render as plain text — no markdown/HTML sink for release-authored
 * content.
 */
export const UpdateDialog: Component = () => {
  const info = requestUpdateDialog_;
  const [installing, setInstalling] = createSignal(false);
  const [progress, setProgress] = createSignal<InstallProgress | null>(null);

  const close = () => {
    // Don't let a click dismiss it mid-install; the relaunch will take over.
    if (installing()) return;
    setRequestUpdateDialog(null);
  };

  const install = async () => {
    if (installing()) return;
    setInstalling(true);
    setProgress(null);
    try {
      await installPendingUpdate((p) => setProgress(p));
      // On success the app relaunches into the new version and never returns
      // here; if it somehow does, the dialog just stays until restart.
    } catch (e) {
      notifyError("Update failed to install", describeIpcError(e));
      setInstalling(false);
    }
  };

  const percent = () => {
    const p = progress();
    if (!p || p.fraction === undefined) return null;
    return Math.round(p.fraction * 100);
  };

  return (
    <Dialog
      open={info() !== null}
      onOpenChange={(open) => {
        if (!open) close();
      }}
      title="Update available"
      description={
        info()
          ? `Typeward ${info()!.version} is ready to install (you're on ${info()!.currentVersion}).`
          : undefined
      }
      widthClass="w-[480px]"
      footer={
        <Show
          when={!installing()}
          fallback={
            <div class="text-sm text-fg-3">
              {percent() !== null
                ? `Downloading… ${percent()}%`
                : "Downloading update…"}
            </div>
          }
        >
          <Button variant="ghost" onClick={close}>
            Later
          </Button>
          <Button
            variant="primary"
            leadingIcon={<Download class="ui-icon-sm" />}
            onClick={() => void install()}
          >
            Install and relaunch
          </Button>
        </Show>
      }
    >
      <Show when={info()}>
        {(i) => (
          <div class="flex flex-col gap-3">
            <Show
              when={i().notes.length > 0}
              fallback={
                <div class="text-sm text-fg-3">
                  This release has no notes. Install to get the latest fixes and
                  improvements.
                </div>
              }
            >
              <div>
                <div class="label-xs mb-1.5 text-fg-3">What's new</div>
                <pre class="mono scroll max-h-64 select-text overflow-auto whitespace-pre-wrap break-words rounded-md p-3 text-xs leading-relaxed text-fg-2 glass-inset">
                  {i().notes}
                </pre>
              </div>
            </Show>
            <div class="text-xs text-fg-3">
              The app closes and reopens on the new version. Unsaved work is
              saved by autosave first.
            </div>
          </div>
        )}
      </Show>
    </Dialog>
  );
};
