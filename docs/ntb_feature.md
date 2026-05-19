# Notebook & R Markdown — archival notes (removed 2026-05-20)

This document exists so that a future implementer can rebuild the notebook
experience without re-doing the discovery work. The code is no longer in the
tree; recover it via `git log --all -- src/lib/notebook/ src-tauri/src/notebook.rs`
at or before commit `<archival commit hash>` (the same commit that introduces
this file).

The companion design spec for the removal lives at
`docs/superpowers/specs/2026-05-20-narrow-formats-md-preview-design.md`.

---

## 1. What was there

A `notebook` `DocumentExperience` for R Markdown (`.Rmd`) projects, distinct
from the `text` experience used by LaTeX / Typst / Markdown projects. Picked at
project creation time; downstream routing in `EditorScreen` branched on
`project.experience`.

The notebook shell parsed the `.Rmd` source into a `Cell[]` model, rendered
each cell as a Solid `<Cell>` with its own CodeMirror instance, and ran R chunks
against a **persistent R kernel** managed by `KernelManager` in the Rust
backend. Variables defined in cell *N* survived into cell *N+1* until the user
hit the "Restart" banner button, which dropped the kernel; the next run
respawned it.

## 2. Why it was removed

Scope reduction pre-release. R Markdown brought a second editor model (cells
vs single body), a long-running child process per project (the R kernel), a
hand-rolled RMD parser that had to round-trip whitespace bit-for-bit, and a
pandoc-shaped compile path — none of which advanced the core LaTeX/Typst
proposition. Cell execution is a worthwhile axis to revisit *after* the editor
core is shipped, ideally with multi-kernel support (Python, Julia) rather than
R-only.

Markdown-as-a-project was retired in the same change. Markdown stays as a
**file** format inside any project — the right pane swaps to an in-app HTML
render (markdown-it + KaTeX + DOMPurify) when the active tab is `.md`. This
replaces the previous `MarkdownAdapter` which shelled out to pandoc.

## 3. Deleted files (and what each owned)

Frontend:

| File | What it owned |
|---|---|
| `src/experiences/types.ts` | `DocumentExperience = "text" \| "notebook" \| "publishing"` |
| `src/screens/editor/shells/notebook-shell.tsx` | Desktop + tablet notebook layout; mounted `<Cell>` list; wired the cell-add/remove/run controls and the Restart banner. |
| `src/components/editor/CellEditor.tsx` | Single-cell CodeMirror wrapper; per-cell extensions + the read-only language switch (R / markdown). |
| `src/components/notebook/Cell.tsx` | Cell shell: chunk header, run button, output container. |
| `src/components/notebook/CellOutput.tsx` | Rendered text/error output streamed back from the R kernel. |
| `src/adapters/rmarkdown/RmarkdownAdapter.ts` | `compile_rmarkdown` IPC delegate (Rscript → rmarkdown::render). |
| `src/adapters/markdown/MarkdownAdapter.ts` | `compile_markdown` IPC delegate (pandoc → PDF via pdflatex/xelatex/lualatex). |
| `src/stores/notebook-store.ts` | `Cell[]` mirror of `editor-store.activeFile.content`; the feedback-loop guard lived here (see Section 4). |
| `src/stores/notebook-outputs-store.ts` | Per-cell stdout/stderr/value buffers keyed by cell id. |
| `src/lib/notebook/parser.ts` | `.Rmd` ↔ `Cell[]` round-trip. Line-mode tokeniser, intentionally not a real markdown grammar. |
| `src/lib/notebook/parser.test.ts` | Round-trip property tests. |
| `src/stores/notebook-store.test.ts` | Store reducer tests including the feedback-loop guard. |

Rust:

| File | What it owned |
|---|---|
| `src-tauri/src/notebook.rs` | `KernelManager` (one long-lived `R --slave` child per project, serialised through a per-kernel `tokio::Mutex`); `notebook.run_r_chunk` and `notebook.stop_r_kernel` Tauri commands. |

Plus the corresponding `invoke_handler!` entries in `commands.rs`/`lib.rs` and
the `notebook.*` IPC wrappers in `src/ipc/index.ts`.

## 4. Architectural decisions worth re-using

These are the things that cost more than a day to discover the first time.

**Persistent R kernel.** The first implementation ran each cell as a fresh
`Rscript` invocation. That looks simple, but it means cell *N+1* can't see
variables defined in cell *N*, which makes R Markdown essentially unusable as
a notebook. The replacement (2026-05-15) spawns one `R --slave` per project,
keeps it alive for the lifetime of the project, and serialises calls through
a per-kernel `tokio::Mutex` so two cells can't race the same stdin. The
kernel is dropped on `notebook.stop_r_kernel` and respawned on next run.

**Feedback-loop guard in `notebook-store`.** Cell edits had to re-serialise
back into `editor-store.activeFile.content` so the existing save / autosave /
file-watcher path kept working — but the watcher then fed those changes back
into the parser, producing a thrash. The guard suppressed the round-trip when
the change *originated* in the editor (vs originating in a cell edit). Without
this guard, every keystroke ping-ponged.

**Hand-rolled line-mode parser.** Using markdown-it for the RMD parse looks
attractive, but markdown-it's AST loses whitespace and reflows blank lines —
the round-trip wasn't bit-identical, which broke autosave snapshot diffs. The
custom parser is line-mode, preserves trailing blanks, and is what made the
RMD ↔ `Cell[]` ↔ RMD round-trip safe.

**Tablet shell parity.** `notebook-shell.tsx` had to mirror the responsive
behaviour of `text-shell.tsx` — single-pane `<Switch>`, `PaneSwitcher`,
slide-up `LogsSheet`, swipe gestures — because users would otherwise hit a
desktop-only layout on iPad. Any re-implementation has to keep this parity
from day one.

## 5. Re-introduction sketch

When this comes back:

1. Re-add `DocumentExperience` (consider extending to `"notebook"` and a
   distinct `"slides"` if Quarto-style presentations also re-enter scope).
2. Re-add `NotebookShell` mirroring the current `TextShell` responsive layout.
3. Re-add `notebook-store` **with the feedback-loop guard from day one**.
4. Re-add the persistent kernel pattern in `src-tauri/src/notebook.rs`. Design
   the kernel trait generically — R was the only kernel last time, but the
   right shape supports Python (`python -i`) and Julia (`julia -i`) too.
5. Re-wire commands: `notebook.runCell`, `notebook.runAll`, and the
   `Mod+Shift+Enter` shortcut in `commands/keyboard.ts`.
6. Restore the deferred follow-ups that never landed last time: per-cell
   plot/image capture (R writes PNG to a temp dir, frontend reads + caches);
   Python and Julia per-cell execution behind the same `KernelManager` trait.

## 6. What was *not* implemented and is still worth doing

Carried over from the prior status notes:

- Plot / image capture from R cells. Currently text output only.
- Python and Julia kernels (per-cell execution). Last `KernelManager` was
  R-specific.
- Smart per-page PDF diff and sync-to-cursor toggle for the notebook shell
  (these were explicitly skipped per user direction; flag again if the user
  re-prioritises them).

## 7. Git anchor

The implementation can be recovered with:

```
git log --all --oneline -- src/lib/notebook/ src-tauri/src/notebook.rs \
                          src/stores/notebook-store.ts \
                          src/screens/editor/shells/notebook-shell.tsx
```

The last commit before this removal is the most complete state.
