import { createSignal } from "solid-js";

/**
 * Route the user came from before navigating to a "modal" screen (Settings).
 * Drives the back affordance so we don't bounce to /projects when the user
 * was deep in the editor.
 *
 * Set this *before* navigating to Settings; the Settings screen reads it on
 * back-button click and clears it after navigating.
 */
const [previousRoute, setPreviousRoute] = createSignal<string | null>(null);

export { previousRoute, setPreviousRoute };
