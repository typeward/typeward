// Headless perf legs for the long-document plan's Phase 0 (docs/plans/
// 2026-08-03-long-document-performance.md). These measure the pure in-tree
// hot paths — the visual-mode per-keystroke pipeline and the outline parser —
// on generated corpus text, and print the numbers so a local run doubles as a
// baseline recording.
//
// The expect() ceilings are NOT the plan's targets (8 ms/keystroke). They are
// order-of-magnitude regression backstops sized for noisy shared CI runners:
// a pass says "not catastrophically regressed", never "fast enough". Tighten
// them only alongside a dedicated, quiet benchmark environment.

import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ChangeSet, Text } from "@codemirror/state";
import {
  MAX_VISUAL_BYTES,
  parseVisualDoc,
  passesSizeGate,
  updateDoc,
} from "../../src/lib/visual/parse";
import { buildDecorations } from "../../src/lib/visual/decorations";
import { parseOutline, type OutlineItem } from "../../src/lib/outline/parse";
import { generateLongChapterText } from "../lib/gen.mjs";

function countItems(items: OutlineItem[]): number {
  let n = 0;
  for (const it of items) n += 1 + countItems(it.children ?? []);
  return n;
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

// Same adapter shape as field.ts's docSource: updateDoc consumes the CM6 Text
// directly, so only the rescanned region ever materializes as a string.
function docOf(t: Text) {
  return {
    length: t.length,
    sliceString: (from: number, to: number) => t.sliceString(from, to),
    lineStartAt: (pos: number) => t.lineAt(pos).from,
  };
}

// Vitest runs with cwd at the repo root; import.meta.url is http-scheme here.
const resultsDir = join(process.cwd(), "bench", "results");

function report(name: string, data: Record<string, number | string>) {
  // One line per leg, appended to the same results dir compile-baseline.mjs
  // writes to (vitest reporters swallow console output on success).
  const line = `${new Date().toISOString()} ${name} ${JSON.stringify(data)}\n`;
  mkdirSync(resultsDir, { recursive: true });
  appendFileSync(join(resultsDir, "editor-hotpaths.jsonl"), line);
}

describe("visual mode at 30k lines", () => {
  // wrap 40 keeps 30k lines under the visual size gate (MAX_VISUAL_BYTES).
  const text = generateLongChapterText({ lines: 30_000, wrap: 40, seed: 42 });

  it("stays under the size gate (bench precondition)", () => {
    expect(text.length).toBeLessThan(MAX_VISUAL_BYTES);
    expect(passesSizeGate(text)).toBe(true);
  });

  it("enable-time full parse + decoration build", () => {
    const cmText = Text.of(text.split("\n"));
    const t0 = performance.now();
    const doc = parseVisualDoc(text, { budgetMs: Infinity });
    const parseMs = performance.now() - t0;
    expect(doc).not.toBeNull();
    const t1 = performance.now();
    buildDecorations(doc!, cmText, {});
    const decoMs = performance.now() - t1;
    report("visual.fullParse.30k", {
      lines: 30_000,
      bytes: text.length,
      parseMs: Math.round(parseMs),
      decorationsMs: Math.round(decoMs),
    });
    expect(parseMs + decoMs).toBeLessThan(10_000);
  });

  it("per-keystroke cost, app path (4ms budget) and total work", () => {
    const KEYSTROKES = 40;
    let doc = parseVisualDoc(text, { budgetMs: Infinity })!;
    let cmText = Text.of(text.split("\n"));
    let built = buildDecorations(doc, cmText, {});
    // Type sequentially mid-document, like a user extending a word.
    const basePos = cmText.line(Math.floor(cmText.lines / 2)).to;

    const appMs: number[] = [];
    const totalMs: number[] = [];
    let stale = 0;
    for (let k = 0; k < KEYSTROKES; k++) {
      const pos = basePos + k;
      const changes = ChangeSet.of({ from: pos, insert: "x" }, cmText.length);
      const newText = changes.apply(cmText);

      // App path: exactly what visualField.update does per transaction —
      // incremental update consuming the CM6 Text under the default budget,
      // then either a full decoration rebuild or (stale) a RangeSet.map of
      // the previous sets. No per-keystroke stringify (the point of the
      // Doc-source change).
      const tApp = performance.now();
      const res = updateDoc(doc, changes, docOf(newText));
      let nextBuilt;
      if (res.stale) {
        nextBuilt = {
          decorations: built.decorations.map(changes),
          atomics: built.atomics.map(changes),
        };
      } else {
        nextBuilt = buildDecorations(res.doc, newText, {});
      }
      appMs.push(performance.now() - tApp);

      if (res.stale) {
        stale++;
        // Off-clock: the idle full reparse the field schedules after a stale
        // frame — the keystroke itself never waits for this. parseVisualDoc
        // still takes a string, so the stringify happens only here.
        doc = parseVisualDoc(newText.toString(), { budgetMs: Infinity })!;
        built = buildDecorations(doc, newText, {});
      } else {
        // Unbudgeted incremental parse alone — isolates the splice cost from
        // the decoration rebuild that dominates the app path.
        const tParse = performance.now();
        updateDoc(doc, changes, docOf(newText), { budgetMs: Infinity });
        totalMs.push(performance.now() - tParse);
        doc = res.doc;
        built = nextBuilt;
      }
      cmText = newText;
    }

    report("visual.keystroke.30k", {
      keystrokes: KEYSTROKES,
      appPathMedianMs: +median(appMs).toFixed(2),
      appPathMaxMs: +Math.max(...appMs).toFixed(2),
      parseOnlyMedianMs: totalMs.length ? +median(totalMs).toFixed(2) : -1,
      staleFrames: stale,
    });
    expect(median(appMs)).toBeLessThan(250);
    // A regression that blows the 4ms budget EVERY keystroke makes the app
    // path look cheaper (early abort + RangeSet.map), so the ceiling alone
    // fails open — always-stale must fail structurally. Baselines show 0-1.
    expect(stale).toBeLessThan(KEYSTROKES / 2);
  });
});

describe("outline parse at 50k lines", () => {
  const text = generateLongChapterText({ lines: 50_000, wrap: 60, seed: 7 });

  it("full-text parseOutline", () => {
    const runs: number[] = [];
    for (let i = 0; i < 5; i++) {
      const t0 = performance.now();
      const items = parseOutline(text, "latex");
      runs.push(performance.now() - t0);
      expect(countItems(items)).toBeGreaterThan(100);
    }
    report("outline.parse.50k", {
      lines: 50_000,
      bytes: text.length,
      medianMs: +median(runs).toFixed(2),
    });
    expect(median(runs)).toBeLessThan(1_000);
  });
});
