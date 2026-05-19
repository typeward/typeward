/* @refresh reload */
import { render } from "solid-js/web";
import App from "./App";
import "./styles.css";
import "katex/dist/katex.min.css";

const root = document.getElementById("root");
if (!root) throw new Error("Root element #root not found");
document.getElementById("boot-splash")?.remove();
render(() => <App />, root);
