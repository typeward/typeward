/*
 * Loaded before the app bundle (see index.html): re-tints the boot splash to
 * the persisted theme so users on a non-default theme don't get a cream
 * flash while the bundle loads. Inline script would be cleaner but the CSP
 * is `script-src 'self'`, so this ships as a tiny external module instead.
 * Keep the palette rows in sync with each theme's bg / fg-1 / fg-3 tokens.
 */

const SPLASH: Record<string, [bg: string, fg: string, dim: string, ring: string]> = {
  daylight: ["#f8f4ea", "#22211e", "#8e8678", "rgba(34, 33, 30, 0.12)"],
  lamplight: ["#0d0c0a", "#ede6d8", "rgba(237, 230, 216, 0.42)", "rgba(255, 255, 255, 0.08)"],
  aurora: ["#0a0b0f", "#e6e8ec", "#6b7280", "rgba(255, 255, 255, 0.08)"],
  paper: ["#faf9f6", "#0b0e14", "#64748b", "rgba(15, 23, 42, 0.12)"],
};

try {
  const raw = localStorage.getItem("typeward.theme");
  const theme = raw ? (JSON.parse(raw) as { theme?: string }).theme : undefined;
  const palette = theme ? SPLASH[theme] : undefined;
  if (palette) {
    const style = document.documentElement.style;
    style.setProperty("--boot-bg", palette[0]);
    style.setProperty("--boot-fg", palette[1]);
    style.setProperty("--boot-dim", palette[2]);
    style.setProperty("--boot-ring", palette[3]);
  }
} catch {
  // No storage / corrupt JSON — the Daylight defaults in index.html apply.
}

export {};
