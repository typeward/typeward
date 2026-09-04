# Long-document benchmarks

This directory holds a reproducible harness for measuring how Typeward and two
rival editors behave on a book-length LaTeX project. `generate.mjs` builds a
deterministic 143-chapter LaTeX book into `bench/corpus/` (gitignored), and
three drivers put each real application through the same operations:

- `drive-ui-baseline.mjs` drives the live Typeward app over CDP
  (WebView2 remote debugging).
- `drive-texstudio-baseline.mjs` drives TeXstudio 4.9.6 through its QJS macro
  engine (portable win-portable-qt6 build extracted to
  `bench/third-party/texstudio/`).
- `drive-latexworkshop-baseline.mjs` drives LaTeX Workshop 10.17.1 in an
  isolated VS Code profile over Electron CDP.

The headline figures quoted in the root README are a representative run on one
Windows 11 machine. The harness is deterministic and self-contained, so you
can reproduce them on your own hardware; expect the absolute numbers to shift
with the machine while the relative picture holds.

## What is measured, and why not compile time

Compile time is not an editor metric. All three editors shell out to the same
TeX engine (latexmk driving pdflatex and biber), a full build of this book
takes tens of seconds in every one of them, and Typeward does not make TeX
itself faster. The one way it shortens the wait is by typesetting less:
"Draft this chapter" recompiles a single chapter against the last full build's
cross-references (`\includeonly`), so one chapter of a large book redraws in
seconds. What an editor otherwise controls is everything around the compile:
how fast it opens, how it completes references, how it switches files, and
what it does to your place in the PDF when a build lands. Those are what the
drivers measure.

- **Opening.** Typeward hands you a live, editable buffer in tens of
  milliseconds; the file loads immediately while the outline and
  language-server index build in the background. The rivals block on parsing
  the whole document first. The honest trade-off: Typeward's full cross-file
  outline (via texlab) is not ready the instant the editor is; on a book this
  size it fills in over the next several seconds.
- **Autocomplete.** Citation and reference completion answers from an
  in-process index of every label and citekey in the project, built in Rust
  and queried synchronously, so the list appears in well under a millisecond
  and holds every candidate rather than a truncated page. The rivals answer
  over an asynchronous language-server or extension round-trip.
- **Tab switching.** Typeward keeps several files' editors mounted at once and
  just shows the active one, so returning to an already-open file never
  rebuilds the editor. A normal chapter switches in ~1 ms and even the worst
  case, a single 50,000-line `.tex`, in ~9 ms (both were ~9 ms and ~30 ms
  before the editor pool). That ties TeXstudio's native in-memory widgets on a
  normal file, stays far ahead of LaTeX Workshop (~23-40 ms), and trails
  TeXstudio only on the 50,000-line file, where ~9 ms is still one frame,
  imperceptibly instant.
- **Reading position after a recompile.** After a build that repaginated the
  document, Typeward puts you back on the same content: it records the
  cursor's line via SyncTeX and scrolls the new PDF there, instead of
  restoring the same pixel offset. LaTeX Workshop keeps the raw scroll
  offset, which slides off the content the moment the page count changes.
  TeXstudio was not measured on this row. Content anchoring is a behavior
  rather than a latency, which is why it is described here and not in the
  README table.

One thing the harness does not yet measure cleanly, named so it is not taken
for a win: per-keystroke latency (single-digit milliseconds in all three on a
normal file).

## Running the harness

```sh
node bench/generate.mjs              # deterministic corpus -> bench/corpus/
node bench/generate.mjs --check      # structure + determinism asserts (CI runs this)
node bench/fetch-ctan.mjs            # lshort + memoir manual -> bench/third-party/
node bench/compile-baseline.mjs bench/corpus/book   # compile + SyncTeX CLI baselines -> bench/results/

# Typeward UI leg (drives the live app over CDP):
#   WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS=--remote-debugging-port=9333 npm run tauri dev
node bench/drive-ui-baseline.mjs bench-book

# Rival baselines (see the one-time setup notes in each driver's header):
node bench/drive-texstudio-baseline.mjs bench-book|bench-chapter-50k [--no-compile]
node bench/drive-latexworkshop-baseline.mjs bench-book|bench-chapter-50k [--no-compile]
```

The editor hot-path perf backstops in `bench/perf/` run as part of `npm test`.
Corpus and results directories are gitignored; only the generators and
drivers are committed.
