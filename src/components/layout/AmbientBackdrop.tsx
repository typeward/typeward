import type { Component } from "solid-js";

/**
 * Four radial-gradient blobs behind all glass surfaces, ported from
 * `design_files/Projects.html` ambient layer. Mounted once at screen root
 * (`absolute inset-0`).
 *
 * The `<div class="grain">` film-grain overlay used to ship here too but
 * was retired 2026-05-15 — `mix-blend-mode: overlay` inside the Windows
 * WebView2 compositor produced visible horizontal banding artifacts where
 * the overlay intersected glass surfaces' `backdrop-filter` regions. The
 * `.grain` CSS is retained (dormant) so a future rebuild with a different
 * blend mode can opt back in.
 *
 * The whole layer can be hidden via Settings → Appearance → Ambient lights.
 */
export const AmbientBackdrop: Component = () => (
  <div class="ambient">
    <div class="blob blob-1" />
    <div class="blob blob-2" />
    <div class="blob blob-3" />
    <div class="blob blob-4" />
  </div>
);
