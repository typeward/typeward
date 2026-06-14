/// <reference types="vitest" />
import { defaultClientConditions, defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  // hot:false under Vitest — solid-refresh's virtual module ("/@solid-refresh")
  // can't be loaded by the vitest module runner and kills .tsx test suites.
  plugins: [solid({ hot: !process.env.VITEST }), tailwindcss()],
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
