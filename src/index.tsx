/* @refresh reload */
import { render } from "solid-js/web";
import { dismissBootSplash } from "./lib/boot-splash";
import { isPreviewWindow } from "./lib/window-role";
import "./styles.css";

// Dynamic on purpose: a static import would drag the ~250 KB SDK (tracing +
// replay) into the guarded boot path (scripts/check-bundle-shape.mjs). The
// chunk loads in parallel with App; anything thrown before init still lands
// in the local telemetry.log via installFrontendErrorHook.
void import("./lib/sentry").then((m) => m.initSentry());

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");

// The detached PDF preview window (E11) loads the SAME index.html with a query
// param. Branch BEFORE importing App: App.tsx runs heavy boot side effects
// (autosave, watcher, cloud/AI init, keyboard router) at module scope, none of
// which belong in the slim preview window. The splash + boot-theme.js run
// identically for both windows.
if (isPreviewWindow) {
  void import("./screens/preview/PreviewWindowApp").then(({ PreviewWindowApp }) => {
    render(() => <PreviewWindowApp />, root);
    window.setTimeout(dismissBootSplash, 4000);
  });
} else {
  void import("./App").then(({ default: App }) => {
    // The splash stays painted (it sits above the app) until the first screen
    // mounts and calls dismissBootSplash() — see src/lib/boot-splash.ts. This
    // safety net guarantees it never strands if a screen fails to mount.
    render(() => <App />, root);
    window.setTimeout(dismissBootSplash, 4000);
  });
}
