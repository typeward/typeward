/**
 * Wall-clock marks for the long-document plan's Phase 0 UI-level legs:
 * project open → editor/outline ready, tab switch → editor ready, compile →
 * PDF visible, first useful LSP completion, and PDF scroll drift across a
 * reload. Recording is always on (a Map write per event — the events are
 * opens, tab switches and compiles, never keystrokes); the console line is
 * dev-only. `window.__typewardPerf.entries` exposes the ring so a driver can
 * read measurements out of a release build where the console is invisible.
 *
 * Semantics: `perfMark` stamps a start; `perfMeasure` records the elapsed
 * time exactly once per (measure name, mark instance) — debounced re-runs
 * against the same mark are dropped, as are marks older than `maxAgeMs`
 * (a stale mark is leftover context, not the cause of what follows). Editor
 * measures end at view construction, one frame before paint. Drift entries
 * repurpose `ms` as the drift magnitude in pages.
 */

export interface PerfEntry {
  name: string;
  ms: number;
  at: number;
  detail?: string;
}

const MAX_ENTRIES = 500;

const entries: PerfEntry[] = [];
const marks = new Map<string, number>();
const consumed = new Map<string, number>();

const DEV = typeof import.meta !== "undefined" && !!import.meta.env?.DEV;

export function perfMark(name: string): void {
  marks.set(name, performance.now());
}

export function perfDiscard(name: string): void {
  marks.delete(name);
}

export function perfMeasure(
  name: string,
  since: string,
  detail?: string,
  maxAgeMs = 10_000,
): number | null {
  const t0 = marks.get(since);
  if (t0 === undefined) return null;
  const now = performance.now();
  if (now - t0 > maxAgeMs) {
    marks.delete(since);
    return null;
  }
  if (consumed.get(name) === t0) return null;
  consumed.set(name, t0);
  const ms = now - t0;
  record({ name, ms, at: Date.now(), detail });
  return ms;
}

export function perfRecord(name: string, ms: number, detail?: string): void {
  record({ name, ms, at: Date.now(), detail });
}

function record(e: PerfEntry): void {
  entries.push(e);
  if (entries.length > MAX_ENTRIES) entries.splice(0, entries.length - MAX_ENTRIES);
  if (DEV) {
    console.log(`PERF ${e.name} ${e.ms.toFixed(1)}ms${e.detail ? ` (${e.detail})` : ""}`);
  }
}

declare global {
  interface Window {
    __typewardPerf?: { entries: PerfEntry[] };
  }
}

if (typeof window !== "undefined") {
  window.__typewardPerf = { entries };
}
