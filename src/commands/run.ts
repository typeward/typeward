import type { EditorCommand } from "~/adapters/types";
import { notifyError } from "~/lib/toast";
import { describeIpcError as errorText } from "~/lib/errors";

/**
 * Single execution path for command `run()` from both the keyboard router and
 * the command palette. A command whose `run` rejects (e.g. `core.save` when the
 * write fails, `references.refreshLibrary` when a provider is unreachable) used
 * to be `void`-dispatched and vanish; here the rejection surfaces as a toast so
 * the user knows the action didn't take. Commands that handle their own errors
 * resolve normally and never toast.
 */
export function dispatchCommand(cmd: EditorCommand): void {
  void (async () => {
    try {
      await cmd.run();
    } catch (e) {
      notifyError(`"${cmd.title}" failed`, errorText(e));
    }
  })();
}
