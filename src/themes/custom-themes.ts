/**
 * Custom theme runtime. Rust validates and lists user JSON themes from
 * `<app_data>/themes/`; this module keeps them in a signal and, when one is
 * active, layers its tokens over the built-in base theme via an injected
 * `<style>` element keyed on `html[data-custom-theme]` (higher specificity
 * than the `[data-theme]` blocks, so every token the file sets wins while
 * everything else falls through to the base).
 */

import { createEffect, createRoot, createSignal } from "solid-js";

import * as ipc from "~/ipc";
import { activeCustomTheme, customThemesEnabled } from "~/stores/ui-store";
import { THEMES, type Theme, setTheme } from "~/themes/theme-store";

const STYLE_EL_ID = "typeward-custom-theme";

const [customThemes, setCustomThemes] = createSignal<ipc.CustomTheme[]>([]);
const [customThemeWarnings, setCustomThemeWarnings] = createSignal<string[]>([]);
const [customThemesLoaded, setCustomThemesLoaded] = createSignal(false);

export async function reloadCustomThemes(): Promise<void> {
  try {
    const result = await ipc.customThemesList();
    setCustomThemes(result.themes);
    setCustomThemeWarnings(result.warnings);
  } catch {
    // Non-Tauri context (Vitest) or first boot before app_data exists.
    setCustomThemes([]);
    setCustomThemeWarnings([]);
  } finally {
    setCustomThemesLoaded(true);
  }
}

// Mirror of the Rust guards — Rust is the boundary, this just keeps a
// hand-crafted IPC response from becoming a style injection in dev tools.
function safeDecl(key: string, value: string): boolean {
  if (!/^--[a-z0-9-]{1,64}$/.test(key)) return false;
  if (value.length === 0 || value.length > 256) return false;
  for (const ch of value) {
    if (ch === ";" || ch === "{" || ch === "}" || ch === "<" || ch === ">" || ch === "\\") {
      return false;
    }
    if (ch.charCodeAt(0) < 0x20) return false;
  }
  return true;
}

function applyTheme(active: ipc.CustomTheme | null): void {
  const html = document.documentElement;
  let styleEl = document.getElementById(STYLE_EL_ID) as HTMLStyleElement | null;
  if (!active) {
    html.removeAttribute("data-custom-theme");
    styleEl?.remove();
    return;
  }
  // The base theme drives every token the file doesn't override, plus
  // downstream light/dark decisions (Markdown preview prose, boot splash).
  setTheme(active.base as Theme);
  const decls = Object.entries(active.tokens)
    .filter(([k, v]) => safeDecl(k, v))
    .map(([k, v]) => `  ${k}: ${v};`)
    .join("\n");
  if (!styleEl) {
    styleEl = document.createElement("style");
    styleEl.id = STYLE_EL_ID;
    document.head.appendChild(styleEl);
  }
  styleEl.textContent = `html[data-custom-theme="${active.id}"] {\n${decls}\n}`;
  html.setAttribute("data-custom-theme", active.id);
}

/** Mounted once from App.tsx alongside the other init chains. */
export function initCustomThemes(): void {
  void reloadCustomThemes();
  createRoot(() => {
    createEffect(() => {
      if (!customThemesLoaded()) return;
      const id = activeCustomTheme();
      const active =
        customThemesEnabled() && id
          ? (customThemes().find((t) => t.id === id && THEMES.includes(t.base as Theme)) ?? null)
          : null;
      applyTheme(active);
    });
  });
}

export { customThemes, customThemeWarnings, customThemesLoaded };
