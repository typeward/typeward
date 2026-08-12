// One-shot expression runner against the live app webview:
//   node bench/cdp-eval.mjs "document.title"
import { connect } from "./lib/cdp.mjs";

const c = await connect();
try {
  console.log(JSON.stringify(await c.evaluate(process.argv[2] ?? "document.title"), null, 2));
} finally {
  c.close();
}
