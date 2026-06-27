/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import { dismissBootSplash } from "./lib/boot-splash";
import "./styles.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");
// The splash stays painted (it sits above the app) until the first screen
// mounts and calls dismissBootSplash() — see src/lib/boot-splash.ts. This
// safety net guarantees it never strands if a screen fails to mount.
render(() => <App />, root);
window.setTimeout(dismissBootSplash, 4000);
