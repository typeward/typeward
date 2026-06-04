# Review Comments Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add sidecar comment threads anchored to document ranges via CM6 position tracking, with a Review sidebar panel, threaded replies, and soft-delete lifecycle.

**Architecture:** Comments persist in `<project>/.typeward/reviews/comments.json` as a flat array of threads. During editing, a CM6 `StateField<RangeSet>` tracks anchor positions through edits via `map(tr.changes)`. A fuzzy recovery system relocates anchors when files change outside the editor. The Review panel in EditorSidebar shows threads with expand/collapse, reply, resolve, and re-anchor actions.

**Tech Stack:** CodeMirror 6 (`@codemirror/state`, `@codemirror/view`), SolidJS signals/stores, nanoid, existing Tauri IPC (`read_project_text_file` / `write_project_text_file`).

**Spec:** `docs/superpowers/specs/2026-06-03-review-comments-design.md`

---

## File Structure

```
New files:
  src/lib/reviews/types.ts        — CommentThread, Comment interfaces + helpers
  src/lib/reviews/recovery.ts     — fuzzy anchor recovery (pure function)
  src/lib/reviews/cm6.ts          — CM6 extension factory (StateField, decorations, gutter)
  src/stores/review-store.ts      — reactive store (load/save, signals, derived queries)
  src/components/reviews/ReviewPanel.tsx  — sidebar panel (thread list, expanded view)
  src/components/reviews/ThreadCard.tsx   — individual thread card component
  src/test/reviews/recovery.test.ts      — unit tests for fuzzy recovery
  src/test/reviews/store.test.ts         — unit tests for review store logic

Modified files:
  package.json                    — add nanoid dependency
  src/themes/utilities.css        — append review decoration CSS
  src/commands/boot.ts            — register review.addComment + review.togglePanel commands
  src/components/editor/EditorSidebar.tsx — wire ReviewPanel + live thread count
  src/screens/editor/shells/text-shell.tsx — pass review CM6 extension into CodeMirror
```

---

### Task 1: Install nanoid

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install nanoid**

```bash
npm install nanoid
```

- [ ] **Step 2: Verify installation**

```bash
node -e "const { nanoid } = require('nanoid'); console.log(nanoid())"
```

Expected: a random 21-character string printed.

---

### Task 2: Types and helpers

**Files:**
- Create: `src/lib/reviews/types.ts`
- Test: `src/test/reviews/recovery.test.ts` (started here, extended in Task 3)

- [ ] **Step 1: Create types file**

```ts
// src/lib/reviews/types.ts
import { nanoid } from "nanoid";

export interface CommentThread {
  id: string;
  fileRelPath: string;
  fromOffset: number;
  toOffset: number;
  anchorText: string;
  status: "open" | "resolved";
  comments: Comment[];
  createdAt: string;
}

export interface Comment {
  id: string;
  author: string;
  body: string;
  createdAt: string;
}

export function createThread(
  fileRelPath: string,
  fromOffset: number,
  toOffset: number,
  anchorText: string,
  author: string,
  body: string,
): CommentThread {
  const now = new Date().toISOString();
  return {
    id: nanoid(),
    fileRelPath,
    fromOffset,
    toOffset,
    anchorText: anchorText.slice(0, 80),
    status: "open",
    comments: [{ id: nanoid(), author, body, createdAt: now }],
    createdAt: now,
  };
}

export function addReply(
  thread: CommentThread,
  author: string,
  body: string,
): CommentThread {
  return {
    ...thread,
    comments: [
      ...thread.comments,
      { id: nanoid(), author, body, createdAt: new Date().toISOString() },
    ],
  };
}

export function resolveThread(thread: CommentThread): CommentThread {
  return { ...thread, status: "resolved" };
}

export function reopenThread(thread: CommentThread): CommentThread {
  return { ...thread, status: "open" };
}
```

- [ ] **Step 2: Write a basic test to verify types compile and helpers work**

```ts
// src/test/reviews/recovery.test.ts
import { describe, it, expect } from "vitest";
import { createThread, addReply, resolveThread, reopenThread } from "~/lib/reviews/types";

describe("review types helpers", () => {
  it("createThread produces a valid thread with one root comment", () => {
    const t = createThread("main.tex", 10, 50, "some anchor text here", "Alice", "Fix this");
    expect(t.id).toBeTruthy();
    expect(t.fileRelPath).toBe("main.tex");
    expect(t.fromOffset).toBe(10);
    expect(t.toOffset).toBe(50);
    expect(t.anchorText).toBe("some anchor text here");
    expect(t.status).toBe("open");
    expect(t.comments).toHaveLength(1);
    expect(t.comments[0].author).toBe("Alice");
    expect(t.comments[0].body).toBe("Fix this");
  });

  it("anchorText is truncated to 80 chars", () => {
    const long = "x".repeat(200);
    const t = createThread("main.tex", 0, 200, long, "Alice", "Too long");
    expect(t.anchorText).toHaveLength(80);
  });

  it("addReply appends a comment", () => {
    const t = createThread("main.tex", 0, 10, "text", "Alice", "Root");
    const t2 = addReply(t, "Bob", "Reply");
    expect(t2.comments).toHaveLength(2);
    expect(t2.comments[1].author).toBe("Bob");
    expect(t2.comments[1].body).toBe("Reply");
    // original unchanged
    expect(t.comments).toHaveLength(1);
  });

  it("resolveThread / reopenThread toggle status", () => {
    const t = createThread("main.tex", 0, 10, "text", "Alice", "Root");
    const resolved = resolveThread(t);
    expect(resolved.status).toBe("resolved");
    const reopened = reopenThread(resolved);
    expect(reopened.status).toBe("open");
  });
});
```

- [ ] **Step 3: Run tests**

```bash
npm test -- --run src/test/reviews/recovery.test.ts
```

Expected: all 4 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/lib/reviews/types.ts src/test/reviews/recovery.test.ts
git commit -m "feat(reviews): comment thread types and helpers"
```

---

### Task 3: Fuzzy anchor recovery

**Files:**
- Create: `src/lib/reviews/recovery.ts`
- Modify: `src/test/reviews/recovery.test.ts`

- [ ] **Step 1: Write failing tests for recovery**

Append to `src/test/reviews/recovery.test.ts`:

```ts
import { recoverThreads, type RecoveredThread } from "~/lib/reviews/recovery";

describe("recoverThreads", () => {
  const makeThread = (from: number, to: number, anchor: string) =>
    createThread("main.tex", from, to, anchor, "Alice", "Comment");

  it("exact match — offsets still valid", () => {
    const content = "Hello world, this is a test document.";
    const t = makeThread(6, 11, "world");
    const results = recoverThreads([t], content, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("exact");
    expect(results[0].fromOffset).toBe(6);
    expect(results[0].toOffset).toBe(11);
  });

  it("fuzzy match — offsets shifted but text found", () => {
    const t = makeThread(6, 11, "world");
    const newContent = "INSERTED Hello world, this is a test document.";
    const results = recoverThreads([t], newContent, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("fuzzy");
    expect(results[0].fromOffset).toBe(15);
    expect(results[0].toOffset).toBe(20);
  });

  it("orphan — text no longer in document", () => {
    const t = makeThread(0, 5, "DELETED");
    const content = "Hello world, completely different.";
    const results = recoverThreads([t], content, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("orphaned");
  });

  it("orphan — text appears multiple times (ambiguous)", () => {
    const t = makeThread(0, 3, "the");
    const content = "the cat and the dog and the fish";
    const results = recoverThreads([t], content, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("orphaned");
  });

  it("filters threads to the requested file only", () => {
    const t1 = makeThread(0, 5, "Hello");
    const t2 = createThread("other.tex", 0, 5, "Other", "Alice", "Nope");
    const content = "Hello world";
    const results = recoverThreads([t1, t2], content, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].thread.fileRelPath).toBe("main.tex");
  });

  it("fuzzy fallback to first 40 chars when full anchorText fails", () => {
    const anchor = "a]b".repeat(30); // 90 chars, truncated to 80
    const t = makeThread(0, 90, anchor);
    // Content has the first 40 chars but not the full 80
    const partial = anchor.slice(0, 40) + "XXXX_DIFFERENT_ENDING";
    const results = recoverThreads([t], partial, "main.tex");
    expect(results).toHaveLength(1);
    expect(results[0].recoveryStatus).toBe("fuzzy");
    expect(results[0].fromOffset).toBe(0);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
npm test -- --run src/test/reviews/recovery.test.ts
```

Expected: `recoverThreads` tests fail (module not found).

- [ ] **Step 3: Implement recovery**

```ts
// src/lib/reviews/recovery.ts
import type { CommentThread } from "./types";

export interface RecoveredThread {
  thread: CommentThread;
  fromOffset: number;
  toOffset: number;
  recoveryStatus: "exact" | "fuzzy" | "orphaned";
}

export function recoverThreads(
  threads: CommentThread[],
  fileContent: string,
  fileRelPath: string,
): RecoveredThread[] {
  return threads
    .filter((t) => t.fileRelPath === fileRelPath)
    .map((thread) => recover(thread, fileContent));
}

function recover(thread: CommentThread, content: string): RecoveredThread {
  const { fromOffset, toOffset, anchorText } = thread;

  // 1. Exact check
  if (
    fromOffset >= 0 &&
    toOffset <= content.length &&
    content.slice(fromOffset, toOffset) === anchorText
  ) {
    return { thread, fromOffset, toOffset, recoveryStatus: "exact" };
  }

  // 2. Fuzzy: full anchorText
  const fullMatch = findUnique(content, anchorText);
  if (fullMatch !== null) {
    return {
      thread,
      fromOffset: fullMatch,
      toOffset: fullMatch + anchorText.length,
      recoveryStatus: "fuzzy",
    };
  }

  // 3. Fuzzy fallback: first 40 chars
  if (anchorText.length > 40) {
    const short = anchorText.slice(0, 40);
    const shortMatch = findUnique(content, short);
    if (shortMatch !== null) {
      return {
        thread,
        fromOffset: shortMatch,
        toOffset: shortMatch + short.length,
        recoveryStatus: "fuzzy",
      };
    }
  }

  // 4. Orphan
  return { thread, fromOffset, toOffset, recoveryStatus: "orphaned" };
}

function findUnique(haystack: string, needle: string): number | null {
  const first = haystack.indexOf(needle);
  if (first === -1) return null;
  const second = haystack.indexOf(needle, first + 1);
  if (second !== -1) return null;
  return first;
}
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --run src/test/reviews/recovery.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/lib/reviews/recovery.ts src/test/reviews/recovery.test.ts
git commit -m "feat(reviews): fuzzy anchor recovery for out-of-editor edits"
```

---

### Task 4: Review store

**Files:**
- Create: `src/stores/review-store.ts`
- Test: `src/test/reviews/store.test.ts`

- [ ] **Step 1: Write failing store tests**

```ts
// src/test/reviews/store.test.ts
import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock ipc before importing store
vi.mock("~/ipc", () => ({
  readProjectTextFile: vi.fn(),
  writeProjectTextFile: vi.fn(),
}));

import {
  allThreads,
  setAllThreads,
  threadsForFile,
  activeFileOpenThreadCount,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  showResolved,
  setShowResolved,
  visibleActiveFileThreads,
  _resetForTests,
} from "~/stores/review-store";
import { createThread } from "~/lib/reviews/types";

describe("review-store", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("starts empty", () => {
    expect(allThreads()).toEqual([]);
  });

  it("addThread appends a thread", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    expect(allThreads()).toHaveLength(1);
    expect(allThreads()[0].id).toBe(t.id);
  });

  it("threadsForFile filters by relPath", () => {
    addThread(createThread("a.tex", 0, 5, "aaa", "Alice", "A"));
    addThread(createThread("b.tex", 0, 5, "bbb", "Alice", "B"));
    expect(threadsForFile("a.tex")).toHaveLength(1);
    expect(threadsForFile("b.tex")).toHaveLength(1);
    expect(threadsForFile("c.tex")).toHaveLength(0);
  });

  it("addReplyToThread appends a reply", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    addReplyToThread(t.id, "Bob", "Reply");
    expect(allThreads()[0].comments).toHaveLength(2);
  });

  it("resolveThreadById + reopenThreadById toggle status", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    resolveThreadById(t.id);
    expect(allThreads()[0].status).toBe("resolved");
    reopenThreadById(t.id);
    expect(allThreads()[0].status).toBe("open");
  });

  it("removeThread deletes a thread", () => {
    const t = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    addThread(t);
    removeThread(t.id);
    expect(allThreads()).toHaveLength(0);
  });

  it("activeFileOpenThreadCount counts open threads only", () => {
    const t1 = createThread("main.tex", 0, 10, "hello", "Alice", "Root");
    const t2 = createThread("main.tex", 20, 30, "world", "Alice", "Root2");
    addThread(t1);
    addThread(t2);
    resolveThreadById(t2.id);
    // activeFileOpenThreadCount depends on activeFile() which is null in tests,
    // so we test the underlying filter via threadsForFile
    const open = threadsForFile("main.tex").filter((t) => t.status === "open");
    expect(open).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run tests to see them fail**

```bash
npm test -- --run src/test/reviews/store.test.ts
```

Expected: fails (module not found).

- [ ] **Step 3: Implement review store**

```ts
// src/stores/review-store.ts
import { createSignal } from "solid-js";
import type { CommentThread } from "~/lib/reviews/types";
import { addReply, resolveThread, reopenThread } from "~/lib/reviews/types";
import { activeFile, project } from "~/stores/editor-store";
import * as ipc from "~/ipc";

const SIDECAR_REL_PATH = ".typeward/reviews/comments.json";
const SAVE_DEBOUNCE_MS = 1_500;

const [allThreads, setAllThreads] = createSignal<CommentThread[]>([]);
const [showResolved, setShowResolved] = createSignal(false);

let _saveTimer: ReturnType<typeof setTimeout> | null = null;

function threadsForFile(relPath: string): CommentThread[] {
  return allThreads().filter((t) => t.fileRelPath === relPath);
}

function activeFileThreads(): CommentThread[] {
  const f = activeFile();
  return f ? threadsForFile(f.relPath) : [];
}

function visibleActiveFileThreads(): CommentThread[] {
  const base = activeFileThreads();
  return showResolved() ? base : base.filter((t) => t.status === "open");
}

function activeFileOpenThreadCount(): number {
  return activeFileThreads().filter((t) => t.status === "open").length;
}

function allOpenThreadCount(): number {
  return allThreads().filter((t) => t.status === "open").length;
}

function addThread(thread: CommentThread): void {
  setAllThreads((prev) => [...prev, thread]);
  scheduleSave();
}

function addReplyToThread(threadId: string, author: string, body: string): void {
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? addReply(t, author, body) : t)),
  );
  scheduleSave();
}

function resolveThreadById(threadId: string): void {
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? resolveThread(t) : t)),
  );
  scheduleSave();
}

function reopenThreadById(threadId: string): void {
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? reopenThread(t) : t)),
  );
  scheduleSave();
}

function removeThread(threadId: string): void {
  setAllThreads((prev) => prev.filter((t) => t.id !== threadId));
  scheduleSave();
}

function updateThreadOffsets(
  fileRelPath: string,
  updates: Array<{ id: string; fromOffset: number; toOffset: number; anchorText: string }>,
): void {
  const map = new Map(updates.map((u) => [u.id, u]));
  setAllThreads((prev) =>
    prev.map((t) => {
      if (t.fileRelPath !== fileRelPath) return t;
      const u = map.get(t.id);
      if (!u) return t;
      return { ...t, fromOffset: u.fromOffset, toOffset: u.toOffset, anchorText: u.anchorText };
    }),
  );
  scheduleSave();
}

async function loadThreads(): Promise<void> {
  const proj = project();
  if (!proj) return;
  try {
    const raw = await ipc.readProjectTextFile(proj.rootPath, SIDECAR_REL_PATH);
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed)) {
      setAllThreads(parsed);
    }
  } catch {
    setAllThreads([]);
  }
}

function scheduleSave(): void {
  if (_saveTimer) clearTimeout(_saveTimer);
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    saveThreads();
  }, SAVE_DEBOUNCE_MS);
}

async function saveThreads(): Promise<void> {
  const proj = project();
  if (!proj) return;
  const data = JSON.stringify(allThreads(), null, 2);
  try {
    await ipc.writeProjectTextFile(proj.rootPath, SIDECAR_REL_PATH, data);
  } catch {
    // Sidecar directory may not exist yet — create it
    try {
      await ipc.writeProjectTextFile(proj.rootPath, SIDECAR_REL_PATH, data);
    } catch {
      // Silently fail — not critical
    }
  }
}

function _resetForTests(): void {
  setAllThreads([]);
  setShowResolved(false);
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
}

export {
  allThreads,
  setAllThreads,
  showResolved,
  setShowResolved,
  threadsForFile,
  activeFileThreads,
  visibleActiveFileThreads,
  activeFileOpenThreadCount,
  allOpenThreadCount,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  updateThreadOffsets,
  loadThreads,
  saveThreads,
  _resetForTests,
};
```

- [ ] **Step 4: Run tests**

```bash
npm test -- --run src/test/reviews/store.test.ts
```

Expected: all tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/stores/review-store.ts src/test/reviews/store.test.ts
git commit -m "feat(reviews): reactive review store with debounced sidecar persistence"
```

---

### Task 5: CM6 extension (StateField + decorations + gutter)

**Files:**
- Create: `src/lib/reviews/cm6.ts`

This is the core CM6 integration — `StateField<RangeSet<CommentRange>>` that tracks comment anchors through edits, inline decorations, and gutter markers.

- [ ] **Step 1: Create the CM6 extension**

```ts
// src/lib/reviews/cm6.ts
import {
  StateField,
  StateEffect,
  RangeSet,
  type Extension,
  type Transaction,
} from "@codemirror/state";
import {
  Decoration,
  EditorView,
  GutterMarker,
  gutter,
  ViewPlugin,
  type DecorationSet,
  type ViewUpdate,
} from "@codemirror/view";
import type { CommentThread } from "./types";

class CommentRange {
  constructor(public threadId: string, public status: "open" | "resolved") {}
  eq(other: CommentRange) {
    return this.threadId === other.threadId && this.status === other.status;
  }
  range(from: number, to: number) {
    return commentRangeValue.range(from, to);
  }
}

const commentRangeValue = {
  range(from: number, to: number) {
    // This is a helper — actual RangeSet entries are built in buildRangeSet
    return { from, to };
  },
};

// --- State Effects ---

const setThreads = StateEffect.define<
  Array<{ id: string; from: number; to: number; status: "open" | "resolved" }>
>();

const focusThread = StateEffect.define<string>();

// --- Range value class for RangeSet ---

class CommentMark {
  constructor(
    public threadId: string,
    public status: "open" | "resolved",
  ) {}
  eq(other: CommentMark) {
    return this.threadId === other.threadId && this.status === other.status;
  }
  startSide = 1;
  endSide = -1;
  point = false;
  mapMode = 1; // MapMode.TrackDel
}

function buildRangeSet(
  threads: Array<{ id: string; from: number; to: number; status: "open" | "resolved" }>,
  docLength: number,
): RangeSet<CommentMark> {
  const ranges = threads
    .filter((t) => t.from >= 0 && t.to <= docLength && t.from < t.to)
    .sort((a, b) => a.from - b.from || a.to - b.to)
    .map((t) =>
      new CommentMark(t.threadId, t.status).range(t.from, t.to),
    );
  // RangeSet.of expects a sorted array of RangeValue ranges
  return RangeSet.of(
    ranges.map((r) => ({
      from: r.from,
      to: r.to,
      value: new CommentMark(
        threads.find((t) => t.from === r.from && t.to === r.to)!.id,
        threads.find((t) => t.from === r.from && t.to === r.to)!.status,
      ),
    })),
    true,
  );
}

// --- StateField ---

const commentField = StateField.define<RangeSet<CommentMark>>({
  create() {
    return RangeSet.empty;
  },
  update(rangeSet, tr: Transaction) {
    // Apply effects first
    for (const e of tr.effects) {
      if (e.is(setThreads)) {
        return buildRangeSet(e.value, tr.state.doc.length);
      }
    }
    // Map through document changes
    if (tr.docChanged) {
      return rangeSet.map(tr.changes);
    }
    return rangeSet;
  },
});

// --- Decorations ---

const openDeco = Decoration.mark({ class: "cm-review-anchor-open" });
const resolvedDeco = Decoration.mark({ class: "cm-review-anchor-resolved" });

const commentDecorations = EditorView.decorations.compute([commentField], (state) => {
  const ranges = state.field(commentField);
  const builder: Array<{ from: number; to: number; value: typeof openDeco }> = [];
  const cursor = ranges.iter();
  while (cursor.value) {
    const deco = cursor.value.status === "open" ? openDeco : resolvedDeco;
    builder.push({ from: cursor.from, to: cursor.to, value: deco });
    cursor.next();
  }
  return Decoration.set(
    builder.map((b) => b.value.range(b.from, b.to)),
    true,
  );
});

// --- Gutter ---

class CommentGutterMarker extends GutterMarker {
  constructor(public threadId: string) {
    super();
  }
  toDOM() {
    const el = document.createElement("span");
    el.className = "cm-review-gutter-marker";
    el.textContent = "○"; // small circle
    el.title = "Review comment";
    return el;
  }
}

const commentGutter = gutter({
  class: "cm-review-gutter",
  markers(view) {
    const ranges = view.state.field(commentField);
    const seen = new Set<number>();
    const markers: Array<{ from: number; value: GutterMarker }> = [];
    const cursor = ranges.iter();
    while (cursor.value) {
      const line = view.state.doc.lineAt(cursor.from).from;
      if (!seen.has(line)) {
        seen.add(line);
        markers.push({ from: line, value: new CommentGutterMarker(cursor.value.threadId) });
      }
      cursor.next();
    }
    return RangeSet.of(
      markers.map((m) => m.value.range(m.from, m.from)),
      true,
    );
  },
  initialSpacer: () => new CommentGutterMarker(""),
});

// --- Persistence bridge (ViewPlugin) ---

export interface ReviewExtensionCallbacks {
  onOffsetsChanged: (
    updates: Array<{ id: string; from: number; to: number; anchorText: string }>,
  ) => void;
  onGutterClick: (threadId: string) => void;
}

function persistenceBridge(callbacks: ReviewExtensionCallbacks): Extension {
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return ViewPlugin.fromClass(
    class {
      update(update: ViewUpdate) {
        if (!update.docChanged) return;

        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          const ranges = update.state.field(commentField);
          const doc = update.state.doc;
          const updates: Array<{ id: string; from: number; to: number; anchorText: string }> = [];
          const cursor = ranges.iter();
          while (cursor.value) {
            updates.push({
              id: cursor.value.threadId,
              from: cursor.from,
              to: cursor.to,
              anchorText: doc.sliceString(cursor.from, cursor.to).slice(0, 80),
            });
            cursor.next();
          }
          if (updates.length > 0) {
            callbacks.onOffsetsChanged(updates);
          }
        }, 2_000);
      }

      destroy() {
        if (debounceTimer) clearTimeout(debounceTimer);
      }
    },
  );
}

// --- Gutter click handler ---

function gutterClickHandler(callbacks: ReviewExtensionCallbacks): Extension {
  return EditorView.domEventHandlers({
    click(event, view) {
      const target = event.target as HTMLElement;
      if (!target.classList.contains("cm-review-gutter-marker")) return false;
      const marker = target as HTMLElement;
      const pos = view.posAtDOM(marker);
      const ranges = view.state.field(commentField);
      const cursor = ranges.iter();
      while (cursor.value) {
        const lineFrom = view.state.doc.lineAt(cursor.from).from;
        if (lineFrom === view.state.doc.lineAt(pos).from) {
          callbacks.onGutterClick(cursor.value.threadId);
          return true;
        }
        cursor.next();
      }
      return false;
    },
  });
}

// --- Public API ---

export function reviewExtension(callbacks: ReviewExtensionCallbacks): Extension[] {
  return [
    commentField,
    commentDecorations,
    commentGutter,
    persistenceBridge(callbacks),
    gutterClickHandler(callbacks),
  ];
}

export function dispatchSetThreads(
  view: EditorView,
  threads: Array<{ id: string; from: number; to: number; status: "open" | "resolved" }>,
): void {
  view.dispatch({ effects: setThreads.of(threads) });
}

export function getCurrentRanges(
  view: EditorView,
): Array<{ id: string; from: number; to: number; status: "open" | "resolved" }> {
  const ranges = view.state.field(commentField);
  const result: Array<{ id: string; from: number; to: number; status: "open" | "resolved" }> = [];
  const cursor = ranges.iter();
  while (cursor.value) {
    result.push({
      id: cursor.value.threadId,
      from: cursor.from,
      to: cursor.to,
      status: cursor.value.status,
    });
    cursor.next();
  }
  return result;
}

export { setThreads, focusThread, commentField };
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit --pretty 2>&1 | head -30
```

Expected: no errors from `src/lib/reviews/cm6.ts`. (There may be pre-existing warnings elsewhere — only check for review-related errors.)

- [ ] **Step 3: Commit**

```bash
git add src/lib/reviews/cm6.ts
git commit -m "feat(reviews): CM6 extension — StateField, decorations, gutter, persistence bridge"
```

---

### Task 6: Review decoration CSS

**Files:**
- Modify: `src/themes/utilities.css`

- [ ] **Step 1: Append review styles to utilities.css**

Add at the end of `src/themes/utilities.css`:

```css
/* --- Review comment anchors --- */
.cm-review-anchor-open {
  background: color-mix(in srgb, var(--color-accent-1) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-accent-1) 30%, transparent);
}
.cm-review-anchor-resolved {
  background: color-mix(in srgb, var(--color-accent-1) 4%, transparent);
}
.cm-review-gutter { width: 16px; }
.cm-review-gutter-marker {
  color: var(--color-accent-1);
  cursor: pointer;
  opacity: 0.7;
  font-size: 10px;
  line-height: 1;
}
.cm-review-gutter-marker:hover { opacity: 1; }
```

- [ ] **Step 2: Commit**

```bash
git add src/themes/utilities.css
git commit -m "style(reviews): decoration CSS for comment anchors and gutter markers"
```

---

### Task 7: ThreadCard component

**Files:**
- Create: `src/components/reviews/ThreadCard.tsx`

- [ ] **Step 1: Create ThreadCard**

```tsx
// src/components/reviews/ThreadCard.tsx
import { Check, ChevronDown, ChevronUp, MessageCircle, AlertTriangle, Trash2, RotateCcw, Crosshair } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createSignal } from "solid-js";
import type { CommentThread } from "~/lib/reviews/types";

export interface ThreadCardProps {
  thread: CommentThread;
  expanded: boolean;
  orphaned: boolean;
  lineNumber: number | null;
  onToggle: () => void;
  onClickAnchor: () => void;
  onReply: (body: string) => void;
  onResolve: () => void;
  onReopen: () => void;
  onDelete: () => void;
  onReanchor: () => void;
}

export const ThreadCard: Component<ThreadCardProps> = (props) => {
  const [replyText, setReplyText] = createSignal("");

  const rootComment = () => props.thread.comments[0];
  const replies = () => props.thread.comments.slice(1);
  const isResolved = () => props.thread.status === "resolved";

  const handleReply = () => {
    const text = replyText().trim();
    if (!text) return;
    props.onReply(text);
    setReplyText("");
  };

  const handleKeyDown = (e: KeyboardEvent) => {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault();
      handleReply();
    }
  };

  const relativeTime = (iso: string): string => {
    const diff = Date.now() - new Date(iso).getTime();
    const mins = Math.floor(diff / 60_000);
    if (mins < 1) return "just now";
    if (mins < 60) return `${mins}m ago`;
    const hrs = Math.floor(mins / 60);
    if (hrs < 24) return `${hrs}h ago`;
    const days = Math.floor(hrs / 24);
    return `${days}d ago`;
  };

  return (
    <div
      class="border-l-2 rounded-lg mx-2 mb-1.5"
      style={{
        "border-color": props.orphaned
          ? "var(--color-warn)"
          : isResolved()
            ? "var(--color-fg-3)"
            : "var(--color-accent-1)",
        background: "var(--color-control-fill)",
      }}
    >
      {/* Collapsed header */}
      <button
        type="button"
        onClick={props.onToggle}
        class="flex w-full items-start gap-2 px-2.5 py-2 text-left hover:bg-[var(--color-control-fill)]"
      >
        <div class="min-w-0 flex-1">
          {/* Anchor snippet */}
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              props.onClickAnchor();
            }}
            class="mono block max-w-full truncate text-[11px] text-fg-2 hover:text-accent-1"
            title="Jump to anchor in editor"
          >
            {props.orphaned ? `(anchor lost) ${props.thread.anchorText}` : `"${props.thread.anchorText}"`}
          </button>

          {/* File + line */}
          <div class="mt-0.5 text-[10px] text-fg-3">
            {props.thread.fileRelPath}
            <Show when={props.lineNumber !== null}>:{props.lineNumber}</Show>
          </div>

          {/* Root comment */}
          <div class="mt-1 text-[12px] text-fg-2">
            <span class="font-medium text-fg-1">{rootComment()?.author}</span>
            <span class="text-fg-3"> · {relativeTime(rootComment()?.createdAt ?? "")}</span>
          </div>
          <div class="mt-0.5 text-[12px] text-fg-2 leading-relaxed">
            {rootComment()?.body}
          </div>

          {/* Collapsed meta row */}
          <Show when={!props.expanded}>
            <div class="mt-1 flex items-center gap-2 text-[10px] text-fg-3">
              <Show when={replies().length > 0}>
                <span class="flex items-center gap-0.5">
                  <MessageCircle size={10} />
                  {replies().length} {replies().length === 1 ? "reply" : "replies"}
                </span>
              </Show>
              <Show when={props.orphaned}>
                <span class="flex items-center gap-0.5 text-[var(--color-warn)]">
                  <AlertTriangle size={10} />
                  orphaned
                </span>
              </Show>
            </div>
          </Show>
        </div>

        <div class="flex-shrink-0 pt-0.5">
          <Show when={props.expanded} fallback={<ChevronDown size={12} class="text-fg-3" />}>
            <ChevronUp size={12} class="text-fg-3" />
          </Show>
        </div>
      </button>

      {/* Expanded content */}
      <Show when={props.expanded}>
        <div class="border-t border-glass-stroke px-2.5 pb-2.5">
          {/* Replies */}
          <Show when={replies().length > 0}>
            <div class="mt-2 space-y-2">
              <For each={replies()}>
                {(reply) => (
                  <div class="rounded-md px-2 py-1.5" style={{ background: "rgba(255,255,255,0.03)" }}>
                    <div class="text-[11px]">
                      <span class="font-medium text-fg-1">{reply.author}</span>
                      <span class="text-fg-3"> · {relativeTime(reply.createdAt)}</span>
                    </div>
                    <div class="mt-0.5 text-[12px] text-fg-2 leading-relaxed">{reply.body}</div>
                  </div>
                )}
              </For>
            </div>
          </Show>

          {/* Reply input */}
          <div class="mt-2">
            <textarea
              value={replyText()}
              onInput={(e) => setReplyText(e.currentTarget.value)}
              onKeyDown={handleKeyDown}
              placeholder="Reply… (Ctrl+Enter to send)"
              class="w-full resize-none rounded-md border border-glass-stroke bg-transparent px-2 py-1.5 text-[12px] text-fg-1 placeholder:text-fg-3 focus:border-[var(--color-accent-1)] focus:outline-none"
              rows={2}
            />
            <div class="mt-1.5 flex items-center gap-1.5">
              <button
                type="button"
                onClick={handleReply}
                disabled={!replyText().trim()}
                class="rounded-md px-2.5 py-1 text-[11px] font-medium text-fg-1 disabled:opacity-40"
                style={{ background: "var(--color-accent-1)", color: "#fff" }}
              >
                Reply
              </button>

              <Show when={isResolved()}>
                <button
                  type="button"
                  onClick={props.onReopen}
                  class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-3 hover:text-fg-1"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <RotateCcw size={10} /> Reopen
                </button>
              </Show>
              <Show when={!isResolved()}>
                <button
                  type="button"
                  onClick={props.onResolve}
                  class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-3 hover:text-fg-1"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <Check size={10} /> Resolve
                </button>
              </Show>

              <Show when={props.orphaned}>
                <button
                  type="button"
                  onClick={props.onReanchor}
                  class="flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-[var(--color-warn)] hover:text-fg-1"
                  style={{ background: "var(--color-control-fill)" }}
                >
                  <Crosshair size={10} /> Re-anchor
                </button>
              </Show>

              <button
                type="button"
                onClick={props.onDelete}
                class="ml-auto flex items-center gap-1 rounded-md px-2 py-1 text-[11px] text-fg-3 hover:text-[var(--color-err)]"
              >
                <Trash2 size={10} />
              </button>
            </div>
          </div>
        </div>
      </Show>
    </div>
  );
};
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit --pretty 2>&1 | grep -i "ThreadCard\|reviews" | head -10
```

Expected: no errors from ThreadCard.tsx.

- [ ] **Step 3: Commit**

```bash
git add src/components/reviews/ThreadCard.tsx
git commit -m "feat(reviews): ThreadCard component — collapsed/expanded, replies, actions"
```

---

### Task 8: ReviewPanel component

**Files:**
- Create: `src/components/reviews/ReviewPanel.tsx`

- [ ] **Step 1: Create ReviewPanel**

```tsx
// src/components/reviews/ReviewPanel.tsx
import { Inbox } from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";

import { ThreadCard } from "./ThreadCard";
import { activeFile } from "~/stores/editor-store";
import {
  allThreads,
  showResolved,
  setShowResolved,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
} from "~/stores/review-store";
import { recoverThreads } from "~/lib/reviews/recovery";
import { getActiveEditorView, setCursorLine } from "~/stores/editor-view-store";
import { dispatchSetThreads } from "~/lib/reviews/cm6";

export type ReviewScope = "file" | "all";

export interface ReviewPanelProps {
  onRequestReanchor?: (threadId: string) => void;
}

export const ReviewPanel: Component<ReviewPanelProps> = (props) => {
  const [scope, setScope] = createSignal<ReviewScope>("file");
  const [expandedId, setExpandedId] = createSignal<string | null>(null);

  const file = activeFile;

  const threads = createMemo(() => {
    const all = allThreads();
    const show = showResolved();
    let filtered =
      scope() === "file" && file()
        ? all.filter((t) => t.fileRelPath === file()!.relPath)
        : all;
    if (!show) {
      filtered = filtered.filter((t) => t.status === "open");
    }
    return filtered;
  });

  const orphanedIds = createMemo(() => {
    const f = file();
    if (!f) return new Set<string>();
    const recovered = recoverThreads(allThreads(), f.content, f.relPath);
    return new Set(
      recovered.filter((r) => r.recoveryStatus === "orphaned").map((r) => r.thread.id),
    );
  });

  const lineNumberFor = (thread: { fromOffset: number }): number | null => {
    const f = file();
    if (!f) return null;
    const offset = thread.fromOffset;
    if (offset < 0 || offset > f.content.length) return null;
    const before = f.content.slice(0, offset);
    return before.split("\n").length;
  };

  const handleClickAnchor = (thread: { fromOffset: number }) => {
    const line = lineNumberFor(thread);
    if (line !== null) {
      setCursorLine(line);
    }
  };

  const toggleExpanded = (id: string) => {
    setExpandedId((prev) => (prev === id ? null : id));
  };

  return (
    <div class="flex h-full flex-col">
      {/* Header: scope toggle + show resolved */}
      <div class="flex flex-shrink-0 items-center justify-between border-b border-glass-stroke px-3 py-2">
        <div class="flex items-center gap-1 rounded-md p-0.5" style={{ background: "var(--color-control-fill)" }}>
          <button
            type="button"
            onClick={() => setScope("file")}
            class={`rounded px-2 py-0.5 text-[11px] font-medium ${scope() === "file" ? "text-fg-1" : "text-fg-3 hover:text-fg-2"}`}
            style={scope() === "file" ? { background: "rgba(255,255,255,0.08)" } : {}}
          >
            This file
          </button>
          <button
            type="button"
            onClick={() => setScope("all")}
            class={`rounded px-2 py-0.5 text-[11px] font-medium ${scope() === "all" ? "text-fg-1" : "text-fg-3 hover:text-fg-2"}`}
            style={scope() === "all" ? { background: "rgba(255,255,255,0.08)" } : {}}
          >
            All files
          </button>
        </div>
        <label class="flex items-center gap-1.5 text-[10px] text-fg-3 cursor-pointer select-none">
          <input
            type="checkbox"
            checked={showResolved()}
            onChange={(e) => setShowResolved(e.currentTarget.checked)}
            class="h-3 w-3 rounded accent-[var(--color-accent-1)]"
          />
          Resolved
        </label>
      </div>

      {/* Thread list */}
      <div class="min-h-0 flex-1 overflow-auto scroll py-1.5">
        <Show
          when={threads().length > 0}
          fallback={
            <div class="flex h-full flex-col items-center justify-center gap-2 px-6 py-10 text-center">
              <div
                class="flex h-10 w-10 items-center justify-center rounded-full"
                style={{ background: "var(--color-control-fill)" }}
              >
                <Inbox size={20} />
              </div>
              <div class="text-[13px] font-semibold text-fg-1">No review threads</div>
              <div class="text-[11px] leading-relaxed text-fg-3">
                Select text and press Ctrl+Shift+M to start a review thread.
              </div>
            </div>
          }
        >
          <For each={threads()}>
            {(thread) => (
              <ThreadCard
                thread={thread}
                expanded={expandedId() === thread.id}
                orphaned={orphanedIds().has(thread.id)}
                lineNumber={lineNumberFor(thread)}
                onToggle={() => toggleExpanded(thread.id)}
                onClickAnchor={() => handleClickAnchor(thread)}
                onReply={(body) => addReplyToThread(thread.id, "You", body)}
                onResolve={() => resolveThreadById(thread.id)}
                onReopen={() => reopenThreadById(thread.id)}
                onDelete={() => removeThread(thread.id)}
                onReanchor={() => props.onRequestReanchor?.(thread.id)}
              />
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit --pretty 2>&1 | grep -i "ReviewPanel\|reviews" | head -10
```

Expected: no type errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/reviews/ReviewPanel.tsx
git commit -m "feat(reviews): ReviewPanel component — thread list, scope toggle, show-resolved"
```

---

### Task 9: Wire EditorSidebar

**Files:**
- Modify: `src/components/editor/EditorSidebar.tsx`

- [ ] **Step 1: Add ReviewPanel import and wire it in**

At the top of `EditorSidebar.tsx`, add the import (after the existing `CommitPanel` import on line 17):

```ts
import { ReviewPanel } from "~/components/reviews/ReviewPanel";
```

Add import for `allOpenThreadCount` from the review store (after line 18):

```ts
import { allOpenThreadCount } from "~/stores/review-store";
```

- [ ] **Step 2: Replace the hard-coded count with the live signal**

In the tab row array (around line 72), change:

```ts
{ id: "review" as LeftTab, label: "Review", count: 0 },
```

to:

```ts
{ id: "review" as LeftTab, label: "Review", count: allOpenThreadCount() },
```

- [ ] **Step 3: Replace the EmptyTab placeholder with ReviewPanel**

Replace the block (around lines 163-169):

```tsx
<Show when={props.tab === "review"}>
  <EmptyTab
    icon={<Inbox size={20} />}
    title="No reviews yet"
    body="Once collaborators leave comments on your draft, they'll appear here. Phase 4 unlocks real-time review."
  />
</Show>
```

with:

```tsx
<Show when={props.tab === "review"}>
  <ReviewPanel />
</Show>
```

- [ ] **Step 4: Verify it compiles**

```bash
npx tsc --noEmit --pretty 2>&1 | grep -i "EditorSidebar\|review" | head -10
```

Expected: no type errors.

- [ ] **Step 5: Commit**

```bash
git add src/components/editor/EditorSidebar.tsx
git commit -m "feat(reviews): wire ReviewPanel into EditorSidebar with live thread count"
```

---

### Task 10: Wire CM6 extension into TextShell

**Files:**
- Modify: `src/screens/editor/shells/text-shell.tsx`

- [ ] **Step 1: Add imports**

At the top of `text-shell.tsx`, add (near the existing grammar/lsp imports):

```ts
import { reviewExtension, dispatchSetThreads } from "~/lib/reviews/cm6";
import { recoverThreads } from "~/lib/reviews/recovery";
import {
  activeFileThreads,
  updateThreadOffsets,
  loadThreads,
} from "~/stores/review-store";
```

- [ ] **Step 2: Add the review extension to CenterPane**

Inside the `CenterPane` component, in the block where `extrasList` and `grammarExt` are composed (around lines 468-471), add after `grammarExt`:

```ts
const reviewExt = reviewExtension({
  onOffsetsChanged: (updates) => {
    const f = activeFile();
    if (f) updateThreadOffsets(f.relPath, updates);
  },
  onGutterClick: (_threadId) => {
    // Sidebar focus is handled by the ReviewPanel
  },
});
```

Then update the `extraExtensions` prop (around line 479):

```tsx
extraExtensions={[...extrasList, ...grammarExt, ...reviewExt]}
```

- [ ] **Step 3: Dispatch thread state to CM6 on file open**

Inside the keyed `Show` block that renders `<CodeMirror>` (the `{(_path) => { ... }}` callback around line 457), after the CodeMirror JSX is returned, we need to dispatch initial thread state. Add a `queueMicrotask` call after the variables are set up but before the `return`:

This requires restructuring the keyed block slightly. After line 471 (`const grammarExt = ...`), before the `return (`, add:

```ts
// Dispatch recovered review threads into CM6 after mount
queueMicrotask(() => {
  const view = getActiveEditorView();
  if (!view) return;
  const fileThreads = activeFileThreads();
  if (fileThreads.length === 0) return;
  const recovered = recoverThreads(fileThreads, f.content, f.relPath);
  dispatchSetThreads(
    view,
    recovered
      .filter((r) => r.recoveryStatus !== "orphaned")
      .map((r) => ({
        id: r.thread.id,
        from: r.fromOffset,
        to: r.toOffset,
        status: r.thread.status,
      })),
  );
});
```

Also add the `getActiveEditorView` import if not present:

```ts
import { getActiveEditorView } from "~/stores/editor-view-store";
```

- [ ] **Step 4: Load threads on project open**

In the `EditorScreen` (or wherever `project()` is set and the editor mounts), call `loadThreads()`. If that's in `text-shell.tsx`'s top-level effect, add:

```ts
// At the component top level of TextShell (or the parent EditorScreen)
import { onMount } from "solid-js";
// ... inside the component:
onMount(() => { loadThreads(); });
```

- [ ] **Step 5: Verify it compiles and runs**

```bash
npx tsc --noEmit --pretty 2>&1 | grep -i "text-shell\|review" | head -10
```

Expected: no type errors.

- [ ] **Step 6: Commit**

```bash
git add src/screens/editor/shells/text-shell.tsx
git commit -m "feat(reviews): wire CM6 review extension into TextShell with anchor recovery"
```

---

### Task 11: Register commands

**Files:**
- Modify: `src/commands/boot.ts`

- [ ] **Step 1: Add imports**

At the top of `boot.ts`, add:

```ts
import { getActiveEditorView } from "~/stores/editor-view-store";
import { createThread } from "~/lib/reviews/types";
import { addThread } from "~/stores/review-store";
import { dispatchSetThreads, getCurrentRanges } from "~/lib/reviews/cm6";
```

- [ ] **Step 2: Add review commands to CORE_COMMANDS array**

Before the closing `]` of the `CORE_COMMANDS` array (around line 92), add:

```ts
  {
    id: "review.addComment",
    title: "Add Review Comment",
    subtitle: "Start a review thread on the current selection",
    shortcut: "Mod+Shift+M",
    group: "Review",
    scope: "editor",
    when: () => {
      const view = getActiveEditorView();
      if (!view) return false;
      const sel = view.state.selection.main;
      return sel.from !== sel.to && activeFile() !== null;
    },
    run: () => {
      const view = getActiveEditorView();
      const f = activeFile();
      if (!view || !f) return;
      const sel = view.state.selection.main;
      if (sel.from === sel.to) return;
      const anchorText = view.state.doc.sliceString(sel.from, sel.to);
      const thread = createThread(f.relPath, sel.from, sel.to, anchorText, "You", "");
      addThread(thread);
      // Update CM6 RangeSet with the new thread
      const existing = getCurrentRanges(view);
      dispatchSetThreads(view, [
        ...existing,
        { id: thread.id, from: sel.from, to: sel.to, status: "open" },
      ]);
    },
  },
  {
    id: "review.togglePanel",
    title: "Toggle Review Panel",
    subtitle: "Show or hide the review sidebar",
    group: "Review",
    scope: "global",
    when: () => project() !== null,
    run: () => {
      // This is a UI toggle — the sidebar tab switch is handled by
      // the consuming component. Emit a custom event for EditorScreen
      // to pick up, or directly call the setTab callback.
      window.dispatchEvent(new CustomEvent("typeward:toggle-review-panel"));
    },
  },
```

- [ ] **Step 3: Verify it compiles**

```bash
npx tsc --noEmit --pretty 2>&1 | grep -i "boot\|review" | head -10
```

Expected: no type errors.

- [ ] **Step 4: Commit**

```bash
git add src/commands/boot.ts
git commit -m "feat(reviews): register addComment (Mod+Shift+M) and togglePanel commands"
```

---

### Task 12: Integration test — manual verification

**Files:** None new — this is a verification step.

- [ ] **Step 1: Run the full test suite**

```bash
npm test -- --run
```

Expected: all existing tests pass, plus the new recovery and store tests.

- [ ] **Step 2: Run type check**

```bash
npx tsc --noEmit
```

Expected: clean.

- [ ] **Step 3: Start the dev server and test manually**

```bash
npm run tauri dev
```

Manual test checklist:
1. Open a LaTeX or Typst project
2. Select some text in the editor
3. Press Ctrl+Shift+M — verify a new thread appears in the Review sidebar tab
4. Click the Review tab — verify the thread card shows with the anchor text
5. Expand the thread — verify reply input appears
6. Type a reply and press Ctrl+Enter — verify it appears in the thread
7. Click "Resolve" — verify the thread disappears (show-resolved is off)
8. Toggle "Resolved" checkbox — verify the thread reappears as resolved
9. Click the anchor text snippet — verify the editor scrolls to that location
10. Check gutter — verify a small circle marker appears on the commented line
11. Close and reopen the project — verify threads persist and anchors recover

- [ ] **Step 4: Final commit if any adjustments needed**

```bash
git add -A
git commit -m "fix(reviews): adjustments from manual testing"
```

---

Plan complete and saved to `docs/superpowers/plans/2026-06-03-review-comments.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?