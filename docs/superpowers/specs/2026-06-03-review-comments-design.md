# Review Comments — Design Spec

Sidecar comment threads anchored to document ranges via CM6 position tracking. Local-first, no collaboration dependency. Threaded replies, soft-delete lifecycle.

## Data Model

### Sidecar file

One file per project at `<project>/.typeward/reviews/comments.json`. All threads across all project files live in a single array — avoids per-file fan-out and simplifies the "All files" view.

```ts
interface CommentThread {
  id: string;                    // nanoid (compact, collision-safe)
  fileRelPath: string;           // relative to project root
  fromOffset: number;            // character offset (inclusive)
  toOffset: number;              // character offset (exclusive)
  anchorText: string;            // first ~80 chars of anchored range, for fuzzy recovery
  status: "open" | "resolved";
  comments: Comment[];           // first = root, rest = replies (chronological)
  createdAt: string;             // ISO 8601
}

interface Comment {
  id: string;                    // nanoid
  author: string;                // from settings (user display name) or git user.name
  body: string;                  // plain text
  createdAt: string;             // ISO 8601
}
```

The watcher already filters `.typeward/` paths, so writes to this file won't trigger file-tree refreshes or autosave feedback loops.

### Types file

`src/lib/reviews/types.ts` — shared by the store, CM6 extension, sidebar panel, and IPC layer.

## CM6 Integration

### StateField

`src/lib/reviews/cm6.ts` exports a CM6 extension factory:

```ts
function reviewExtension(opts: {
  threads: Accessor<CommentThread[]>;   // reactive signal scoped to active file
  onThreadsChange: (threads: CommentThread[]) => void;
}): Extension[]
```

Internally:

- **`StateField<RangeSet<CommentRange>>`** — `CommentRange` extends `RangeValue` and carries `threadId: string`. Initialized from `opts.threads()` on creation. On each transaction, `rangeSet.map(tr.changes)` tracks positions. `MapMode.TrackDel` flags ranges whose anchor was fully deleted.

- **`StateEffect`** for external mutations: `addThread`, `removeThread`, `updateThreads` (bulk reload). The extension listens for these effects in the StateField's `update` method.

- **Inline decoration**: `Decoration.mark({ class: "cm-review-anchor" })` on the anchored range. Open threads get `cm-review-anchor-open` (subtle accent wash), resolved get `cm-review-anchor-resolved` (lower opacity). Derived from the RangeSet via `EditorView.decorations`.

- **Gutter marker**: `GutterMarker` subclass rendering a small comment bubble icon on the first line of each thread. Click handler dispatches a custom effect that the Review panel listens to (scroll-to-thread).

- **Persistence bridge**: a `ViewPlugin` that, on `update`, checks if any positions changed (comparing pre/post offsets from the mapped RangeSet). If so, debounced at 2s, calls `opts.onThreadsChange(updatedThreads)` with the new offsets and refreshed `anchorText` snippets. This is the only write-back path during a session.

### Decoration CSS

In `src/themes/utilities.css` (or a new `reviews.css` imported there):

```css
.cm-review-anchor-open {
  background: color-mix(in srgb, var(--color-accent-1) 10%, transparent);
  border-bottom: 1px solid color-mix(in srgb, var(--color-accent-1) 30%, transparent);
}
.cm-review-anchor-resolved {
  background: color-mix(in srgb, var(--color-accent-1) 4%, transparent);
}
.cm-review-gutter-marker {
  color: var(--color-accent-1);
  cursor: pointer;
  opacity: 0.7;
}
.cm-review-gutter-marker:hover { opacity: 1; }
```

Uses `color-mix()` to stay consistent with the existing token system — no raw RGB triplet tokens needed.

## Fuzzy Recovery

On file open, before materializing the RangeSet:

1. **Exact check**: `fileContent.slice(thread.fromOffset, thread.toOffset) === thread.anchorText` — use directly.
2. **Fuzzy search**: if exact fails, `fileContent.indexOf(thread.anchorText)`. If exactly one match, remap `fromOffset`/`toOffset` to the match location. If `anchorText` is long and `indexOf` fails, try a substring of the first 40 chars.
3. **Orphan**: zero or multiple matches → add `orphaned: true` flag (runtime-only, not persisted as a status — the thread stays `"open"` in the sidecar). Orphaned threads appear in the Review panel with an amber warning badge and a "Re-anchor" action.

Recovery runs in `src/lib/reviews/recovery.ts` as a pure function: `recoverThreads(threads: CommentThread[], fileContent: string): RecoveredThread[]` where each result carries `{ thread, fromOffset, toOffset, recoveryStatus: "exact" | "fuzzy" | "orphaned" }`.

## Review Store

`src/stores/review-store.ts` — the central reactive store.

```ts
const [allThreads, setAllThreads] = createSignal<CommentThread[]>([]);
const [showResolved, setShowResolved] = createSignal(false);

// Derived
const threadsForFile = (relPath: string) =>
  allThreads().filter(t => t.fileRelPath === relPath);

const activeFileThreads = () => {
  const f = activeFile();
  return f ? threadsForFile(f.relPath) : [];
};

const visibleThreads = () => {
  const base = activeFileThreads();
  return showResolved() ? base : base.filter(t => t.status === "open");
};

const threadCount = () =>
  allThreads().filter(t => t.status === "open").length;
```

**Load**: on project open, read `<project>/.typeward/reviews/comments.json` via `readProjectTextFile`. Parse, set signal. If file doesn't exist, start with `[]`.

**Save**: debounced writer (similar to autosave) — serialize `allThreads()` to JSON, write via `writeProjectTextFile` to the sidecar path. Triggered by the CM6 persistence bridge callback and by direct mutations (add/reply/resolve).

No new Rust IPC commands needed — the existing `read_project_text_file` / `write_project_text_file` pair works since `comments.json` is a text file under the project root's `.typeward/` directory.

## Review Panel (Sidebar)

`src/components/reviews/ReviewPanel.tsx` — replaces the `EmptyTab` in `EditorSidebar` for the `"review"` tab.

### Layout

```
┌─────────────────────────────┐
│ ○ This file  ○ All files    │  ← scope segmented control
│ [Show resolved ☐]           │  ← toggle, right-aligned
├─────────────────────────────┤
│                             │
│  ThreadCard                 │  ← one per visible thread
│  ┌─────────────────────┐    │
│  │ "snippet of text…"  │    │  ← clickable anchor text (mono, truncated)
│  │ main.tex:42          │   │  ← file + line
│  │ Author · 2h ago      │   │  ← root comment meta
│  │ "comment body…"      │   │  ← root comment text
│  │ 💬 2 replies         │   │  ← reply count chip (collapsed)
│  │ ● Open               │   │  ← status pill
│  └─────────────────────┘    │
│                             │
│  (expanded thread)          │
│  ┌─────────────────────┐    │
│  │ reply 1              │   │
│  │ reply 2              │   │
│  │ [Type a reply…    ]  │   │  ← input + send button
│  │ [Resolve]            │   │  ← resolve/reopen button
│  └─────────────────────┘    │
│                             │
├─────────────────────────────┤
│ Empty state (when no        │
│ threads): Inbox icon +      │
│ "Select text and press      │
│  Ctrl+Shift+M to start     │
│  a review thread."          │
└─────────────────────────────┘
```

### Interactions

- **Click anchor text** → `setCursorLine()` + brief highlight pulse on the anchored range in the editor (dispatch a transient decoration effect that fades after ~1.5s).
- **Click thread card** → expand/collapse inline (accordion, only one expanded at a time).
- **Add reply** → append to `thread.comments`, trigger save.
- **Resolve** → set `thread.status = "resolved"`, trigger save. Thread disappears from view unless "Show resolved" is on.
- **Reopen** → set `thread.status = "open"`, only visible when "Show resolved" is on and thread is resolved.
- **Re-anchor** (orphaned threads) → prompt user to select text in editor, then update the thread's offsets + anchorText to the selection. Clear orphaned flag.
- **Delete thread** → remove from `allThreads`. Only available on threads the user authored (compare `author` to current identity).

### Orphaned thread display

Orphaned threads render with an amber left border and a warning icon. The anchor text area shows the original `anchorText` with "(anchor lost)" label. "Re-anchor" button is primary; "Dismiss" removes the thread.

## Command Registration

Two commands registered in `src/commands/boot.ts` (core commands, not adapter-scoped — comments work across formats):

| ID | Title | Shortcut | Scope | When |
|---|---|---|---|---|
| `review.addComment` | Add Review Comment | `Mod+Shift+M` | editor | `activeFile() !== null` and editor has a non-empty selection |
| `review.togglePanel` | Toggle Review Panel | — | global | `project() !== null` |

`review.addComment` flow:
1. Read selection range from `getActiveEditorView()`.
2. Create a new `CommentThread` with the selection's `from`/`to` as offsets, `anchorText` from the selected content.
3. Add to `allThreads()`.
4. Switch sidebar to Review tab, expand the new thread, focus the comment input.

## Integration Points

### TextShell (`src/screens/editor/shells/text-shell.tsx`)

Pass the review CM6 extension into `<CodeMirror extraExtensions>`, alongside LSP and grammar extensions. The extension is created per-file (keyed on `activeFile().path` like everything else in TextShell).

```ts
const reviewExt = reviewExtension({
  threads: activeFileThreads,
  onThreadsChange: (updated) => {
    // Merge updated offsets back into allThreads for the active file
    // Trigger debounced save
  },
});
```

### EditorSidebar

- Replace `<EmptyTab>` for `"review"` with `<ReviewPanel />`.
- Wire the thread count badge: `count: threadCount()` instead of hard-coded `0`.

### Watcher

No changes — `.typeward/` paths are already filtered.

### Autosave

No interaction — comments persist independently from document autosave.

## File Structure (New)

```
src/lib/reviews/
  types.ts          — CommentThread, Comment interfaces
  cm6.ts            — CM6 extension factory (StateField, decorations, gutter)
  recovery.ts       — fuzzy anchor recovery (pure function)
src/stores/
  review-store.ts   — reactive store (allThreads signal, load/save, derived queries)
src/components/reviews/
  ReviewPanel.tsx   — sidebar panel (thread list, expanded view, inputs)
  ThreadCard.tsx    — individual thread card component
```

## Out of Scope

- Real-time collaborative comments (needs Yjs/Supabase realtime — separate feature).
- Markdown rendering in comment bodies (plain text only for now).
- Comment export to PDF annotations (ExportMenu already has the stub — separate feature).
- TODO tab collection (separate feature, similar pattern but scans document content instead of sidecar).
- Notification system for comment events.
