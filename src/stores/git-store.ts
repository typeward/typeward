import { createSignal } from "solid-js";

/**
 * Monotonic version bumped after an in-app git operation that changes whether
 * the active project is a repository (init today; a future in-place clone).
 * Presence checks like the editor sidebar's `.git` probe key on it so the SCM
 * tab appears right after `git init` instead of only on the next project
 * reopen. The unified file watcher can't drive this — `.git/` churn is filtered
 * at the Rust source to avoid autosave feedback loops.
 */
const [gitStateVersion, setGitStateVersion] = createSignal(0);

export { gitStateVersion };

export const bumpGitState = (): void => {
  setGitStateVersion((v) => v + 1);
};
