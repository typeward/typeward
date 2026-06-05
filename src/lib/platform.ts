let _mobile: boolean | null = null;

export function isMobilePlatform(): boolean {
  if (_mobile !== null) return _mobile;
  try {
    // Tauri on Android always sets wv:// or Android in the UA.
    // Tauri on iOS sets iPhone/iPad. This covers all mobile Tauri targets.
    // Returns false in non-browser contexts (Vitest, SSR) via the catch.
    const ua = navigator?.userAgent ?? "";
    _mobile = /Android|iPad|iPhone/i.test(ua);
  } catch {
    _mobile = false;
  }
  return _mobile;
}

// Tauri-specific: check __TAURI_INTERNALS__ for a more reliable mobile signal.
// Falls back to UA sniffing if Tauri internals aren't available yet.
export function isTauriMobile(): boolean {
  try {
    const ti = (globalThis as Record<string, unknown>).__TAURI_INTERNALS__ as
      | { metadata?: { platform?: string } }
      | undefined;
    if (ti?.metadata?.platform) {
      return ti.metadata.platform === "android" || ti.metadata.platform === "ios";
    }
  } catch { /* fall through */ }
  return isMobilePlatform();
}
