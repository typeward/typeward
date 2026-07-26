// Vitest global setup (registered in vite.config.ts `test.setupFiles`).
//
// Node >= 22.4 defines an experimental global `localStorage` accessor that
// returns `undefined` unless the process was started with `--localstorage-file`.
// Under vitest's jsdom environment `window === globalThis`, so that native
// accessor shadows jsdom's Storage: every bare `localStorage` reference in app
// code and tests resolves to `undefined` and throws. The accessor is
// configurable, so install a real in-memory Storage over it. Test-only.
function memoryStorage(): Storage {
  const m = new Map<string, string>();
  return {
    get length() {
      return m.size;
    },
    clear() {
      m.clear();
    },
    getItem(key: string) {
      return m.has(key) ? m.get(key)! : null;
    },
    setItem(key: string, value: string) {
      m.set(String(key), String(value));
    },
    removeItem(key: string) {
      m.delete(key);
    },
    key(index: number) {
      return [...m.keys()][index] ?? null;
    },
  } as Storage;
}

for (const name of ["localStorage", "sessionStorage"] as const) {
  Object.defineProperty(globalThis, name, {
    value: memoryStorage(),
    configurable: true,
    writable: true,
  });
}
