/// <reference types="vitest/config" />
import { defaultClientConditions, defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

// KaTeX ships woff2 + woff + ttf for all 20 math faces; every Tauri webview
// target (WebKitGTK / WKWebView / WebView2 / Android WebView) supports woff2,
// so the woff/ttf fallbacks (~876 KB) are dead weight. Strip them from the
// stylesheet before Vite resolves url()s, so those files are never emitted.
function katexWoff2Only() {
  return {
    name: "katex-woff2-only",
    enforce: "pre" as const,
    transform(code: string, id: string) {
      if (!id.replace(/\\/g, "/").includes("katex/dist/katex.min.css")) {
        return null;
      }
      const stripped = code.replace(
        /,url\([^)]+\)\s*format\("(?:woff|truetype)"\)/g,
        "",
      );
      return stripped === code ? null : { code: stripped, map: null };
    },
  };
}

export default defineConfig({
  // hot:false under Vitest — solid-refresh's virtual module ("/@solid-refresh")
  // can't be loaded by the vitest module runner and kills .tsx test suites.
  plugins: [solid({ hot: !process.env.VITEST }), tailwindcss(), katexWoff2Only()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // Force Solid's development runtime when running under Vitest. Without dev
    // conditions, signal subscribers get tree-shaken and effects don't re-run
    // in jsdom. Vite 6 REPLACES the default conditions instead of appending,
    // so splice "development" into the defaults rather than dropping `module`
    // etc. Production builds skip this branch entirely.
    conditions: process.env.VITEST
      ? [
          ...defaultClientConditions.filter((c) => c !== "development|production"),
          "development",
        ]
      : undefined,
  },

  // Tauri expects a fixed port; fail if it's not available
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    hmr: host
      ? {
          protocol: "ws",
          host,
          port: 1421,
        }
      : undefined,
    watch: {
      // Tauri/Cargo files are watched by Tauri, not Vite
      ignored: ["**/src-tauri/**"],
    },
  },

  // texlive-wasm spawns its Web Worker via new URL("assets/worker-*.js",
  // import.meta.url). Dev prebundling would relocate the module into
  // .vite/deps and break that relative resolution — serve it as-is instead.
  optimizeDeps: {
    exclude: ["texlive-wasm"],
  },

  // Env vars prefixed with VITE_ are exposed to the client; TAURI_ENV_* come from Tauri
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    // `true` uses Vite 8's default Oxc minifier. The old "esbuild" minifier is
    // deprecated under Rolldown-Vite and mishandled __VITE_PRELOAD__ markers.
    minify: !process.env.TAURI_ENV_DEBUG,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    // The codemirror vendor chunk is a deliberately-split, long-cached vendor
    // bundle (~240 KB gzip); it legitimately exceeds the 500 KB raw default.
    chunkSizeWarningLimit: 800,
    rolldownOptions: {
      output: {
        // The editor screen otherwise collapses CodeMirror + PDF.js + the
        // markdown stack into one ~1.5 MB chunk. Splitting the heavy vendors
        // into their own cacheable chunks lets the webview parse them in
        // parallel and keeps an editor-code edit from busting the vendor cache.
        // (katex/markdown-it only load via the lazy MarkdownPreview import, so
        // that group just gives the async chunk a stable name.)
        // @replit/codemirror-vim is intentionally NOT grouped here — it's
        // dynamically imported and must stay in its own async chunk so the
        // default vim-off config never loads it.
        advancedChunks: {
          groups: [
            {
              // Rolldown hoists shared runtime helpers (Vite's preload helper,
              // transform helpers) into whichever group first captures them —
              // landing them in a vendor chunk makes the ENTRY statically
              // import that whole vendor bundle at boot (this happened with
              // pdfjs: ~465 KB parsed pre-paint for ~1 KB of helper code).
              // Capture them first into a tiny always-loaded chunk instead.
              name: "runtime-helpers",
              // Ids are NUL-prefixed virtual modules: "\0vite/preload-helper.js",
              // "\0@oxc-project+runtime@x.y.z/helpers/esm/defineProperty.js", …
              test: /^\0(?:vite\/|@oxc-project\+runtime@)/,
            },
            {
              name: "codemirror",
              test: /[\\/]node_modules[\\/](@codemirror|@lezer)[\\/]/,
            },
            { name: "pdfjs", test: /[\\/]node_modules[\\/]pdfjs-dist[\\/]/ },
            {
              name: "markdown",
              test: /[\\/]node_modules[\\/](katex|markdown-it|markdown-it-anchor|dompurify|entities|linkify-it|mdurl|uc\.micro|punycode\.js)[\\/]/,
            },
          ],
        },
      },
    },
  },

  test: {
    environment: "jsdom",
    globals: true,
    server: {
      deps: { inline: [/solid-js/, /@solidjs\/router/] },
    },
    alias: {
      "solid-js/web": "solid-js/web/dist/dev.js",
      "solid-js": "solid-js/dist/dev.js",
    },
  },
});
