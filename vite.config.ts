/// <reference types="vitest" />
import { defineConfig } from "vite";
import solid from "vite-plugin-solid";
import tailwindcss from "@tailwindcss/vite";
import { fileURLToPath, URL } from "node:url";

const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [solid(), tailwindcss()],
  resolve: {
    alias: {
      "~": fileURLToPath(new URL("./src", import.meta.url)),
    },
    // Force Solid's development runtime when running under Vitest. Without dev
    // conditions, signal subscribers get tree-shaken and effects don't re-run
    // in jsdom. Production builds (`vite build`) skip this branch and keep
    // Vite's normal `production` resolution.
    conditions: process.env.VITEST ? ["development", "browser"] : undefined,
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

  // Env vars prefixed with VITE_ are exposed to the client; TAURI_ENV_* come from Tauri
  envPrefix: ["VITE_", "TAURI_ENV_*"],
  build: {
    target:
      process.env.TAURI_ENV_PLATFORM === "windows" ? "chrome105" : "safari13",
    minify: !process.env.TAURI_ENV_DEBUG ? "esbuild" : false,
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
