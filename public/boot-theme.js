/*
 * Classic script referenced directly from index.html and served verbatim from
 * public/ — deliberately OUTSIDE the Vite bundle graph. As a module it would
 * be merged into the app entry, and ES import ordering would delay the
 * re-tint until the entire boot graph had been fetched and parsed — exactly
 * the window it exists to cover. Inline would be cleaner still, but the CSP
 * is `script-src 'self'`.
 *
 * Re-tints the boot splash to the persisted theme so users on a non-default
 * theme don't get a cream flash while the bundle loads. Keep the palette
 * rows in sync with each theme's bg / fg-1 / fg-3 tokens.
 */

(function () {
  var SPLASH = {
    light: ["#ffffff", "#1a1d21", "#697077", "rgba(26, 29, 33, 0.12)"],
    dark: ["#1e1e1e", "#d4d4d4", "rgba(212, 212, 212, 0.5)", "rgba(255, 255, 255, 0.08)"],
    daylight: ["#f8f4ea", "#22211e", "#756e62", "rgba(34, 33, 30, 0.12)"],
    lamplight: ["#0d0c0a", "#ede6d8", "rgba(237, 230, 216, 0.51)", "rgba(255, 255, 255, 0.08)"],
    aurora: ["#0a0b0f", "#e6e8ec", "#7d8593", "rgba(255, 255, 255, 0.08)"],
    paper: ["#faf9f6", "#0b0e14", "#64748b", "rgba(15, 23, 42, 0.12)"],
  };

  try {
    var raw = localStorage.getItem("typeward.theme");
    var theme = raw ? JSON.parse(raw).theme : undefined;
    var palette = theme ? SPLASH[theme] : undefined;
    if (palette) {
      var style = document.documentElement.style;
      style.setProperty("--boot-bg", palette[0]);
      style.setProperty("--boot-fg", palette[1]);
      style.setProperty("--boot-dim", palette[2]);
      style.setProperty("--boot-ring", palette[3]);
    }
  } catch (e) {
    // No storage / corrupt JSON — the Daylight defaults in index.html apply.
  }
})();
