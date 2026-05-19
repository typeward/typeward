# Narrow project formats; live Markdown file preview

**Date:** 2026-05-20
**Status:** approved (design); implementation plan to follow
**Scope:** retire R Markdown, the notebook experience, and Markdown-as-a-project. Keep `.md` files openable inside any project with a live HTML preview in the right pane.

---

## 1. Goal

Reduce Typeward's supported project formats to **LaTeX** and **Typst** only,
and replace the previous "Markdown project" model with **Markdown-as-a-file**:
any `.md` tab inside a LaTeX or Typst project renders to a sandboxed HTML
preview in the right pane, live as the user types.

R Markdown, the notebook experience, the persistent R kernel, and the
Markdown-via-pandoc compile path are all removed. Notebook code is archived
to `docs/ntb_feature.md` (companion document) so a future implementer can
rebuild it without re-doing the discovery work.

## 2. Non-goals

- No migration of existing on-disk Markdown or R Markdown projects. The app
  is pre-release; the user will delete any such projects manually.
- No HTML preview for `.qmd` (Quarto stays out of scope per existing memory).
- No new compile or export path for `.md` files. Markdown previews are a
  view-only feature; they do not participate in `compileActiveProject`.
- No feature flag for the removed code. Hard delete; recover from git history
  if ever needed.

## 3. Type-system changes

`src/adapters/types.ts`:

```ts
export type ProjectFormat = "latex" | "typst";

export interface EditorAdapter {
  languageId: string;
  format: ProjectFormat;
  previewKind: "pdf";
  cmExtensions(): CodeMirrorExtension[];
  compile(project: Project): Promise<CompileResult>;
  commands: EditorCommand[];
}
```

`Project.experience` is removed entirely. The on-disk `.typeward/project.json`
schema drops the field; the Rust `project.rs` loader ignores it if present
and stops emitting it on save. There is no `DocumentExperience` type anymore.

`EditorAdapter.previewKind` narrows to `"pdf"`. The `"html"` and `"notebook"`
variants disappear. The Markdown HTML preview is **not** an adapter — it is a
tab-scoped preview, since Markdown lives as a peer file inside LaTeX/Typst
projects rather than as a root format.

## 4. Markdown preview architecture

**Module:** `src/components/preview/MarkdownPreview.tsx` (new).

Props:

```ts
interface MarkdownPreviewProps {
  content: () => string;         // reactive — re-renders on change
  baseDir: string;               // active file's directory; resolves relative paths
  theme: () => "dark" | "light"; // for KaTeX + code-block styling
}
```

Pipeline, per render:

1. `markdown-it` configured with `html: false`, `linkify: true`, GFM tables on,
   smartypants off.
2. `markdown-it-katex` for `$…$` inline and `$$…$$` block math.
3. `markdown-it-anchor` for heading ids (enables in-document `#section` links).
4. A `replaceLink` rule rewrites relative `src` / `href` to `file://` URLs
   anchored at `baseDir`.
5. `DOMPurify.sanitize()` with `file://` whitelisted on `<img src>` only.
6. Result assigned via `innerHTML`.

**Re-render trigger:** `createEffect` on `content()`, throttled with an 80 ms
trailing debounce. No virtualisation; full re-render per change is cheaper
than diffing for the sizes we expect.

**Routing into the preview pane** in `src/screens/editor/shells/text-shell.tsx`:

```tsx
const previewKind = createMemo<"pdf" | "markdown">(() => {
  const f = activeFile();
  return f?.relPath.toLowerCase().endsWith(".md") ? "markdown" : "pdf";
});

<Switch>
  <Match when={previewKind() === "markdown"}>
    <MarkdownPreview
      content={() => activeFile()!.content}
      baseDir={projectDirOf(activeFile()!)}
      theme={theme}
    />
  </Match>
  <Match when={previewKind() === "pdf"}>
    <PdfViewer ... />
  </Match>
</Switch>
```

`PdfViewer`'s scroll position is retained in its own store, so flipping
md → pdf → md does not reset PDF state. The `PaneSwitcher` "Preview" tab
label is unchanged.

`SyncTeX`, LSP, and compile commands remain gated on `format === "latex"` or
`format === "typst"`. Markdown files do not get LSP (marksman is being
removed).

**New dependencies:** `markdown-it`, `@types/markdown-it`, `markdown-it-katex`,
`markdown-it-anchor`, `dompurify`, `katex` (CSS + fonts). Roughly +320 KB gz.
No native deps; no Rust changes for this section.

## 5. Component-by-component change list

### 5.1 Hard deletes — frontend

- `src/experiences/types.ts`
- `src/screens/editor/shells/notebook-shell.tsx`
- `src/components/editor/CellEditor.tsx`
- `src/components/notebook/` (entire folder: `Cell.tsx`, `CellOutput.tsx`)
- `src/adapters/rmarkdown/RmarkdownAdapter.ts`
- `src/adapters/markdown/MarkdownAdapter.ts`
- `src/stores/notebook-store.ts` + `notebook-store.test.ts`
- `src/stores/notebook-outputs-store.ts`
- `src/lib/notebook/` (parser.ts + parser.test.ts)
- Notebook-specific cases in `src/commands/boot.test.ts` (file kept, RMD/notebook rows stripped)

### 5.2 Hard deletes — Rust

- `src-tauri/src/notebook.rs`
- `notebook.*` Tauri commands from `commands.rs` and `lib.rs` `invoke_handler!`
- `KernelManager` state from app setup
- `marksman` LSP wiring in `lsp.rs` (LSP transport itself stays — texlab and
  tinymist still need it)
- `Cargo.toml`: drop any dependencies that only `notebook.rs` used (verified
  during implementation)

### 5.3 Edits

- `src/adapters/types.ts` — narrow `ProjectFormat`, narrow `EditorAdapter.previewKind`, remove `experience` from `Project`
- `src/adapters/adapter-contract.test.ts` — drop notebook/markdown/rmd rows
- `src/screens/editor/EditorScreen.tsx` — `adapterForFormat()` two-case; `<Switch>` branch on `experience` removed (TextShell is the only shell); notebook imports gone
- `src/screens/editor/shells/text-shell.tsx` — add the preview `<Switch>` from Section 4; import `MarkdownPreview`
- `src/screens/onboarding/OnboardingScreen.tsx` — `FormatOption.id` narrows; `FORMATS` array loses markdown + rmarkdown entries; default picked set becomes `["latex"]`; `FORMAT_PILLS` keeps only LaTeX + Typst
- `src/screens/projects/ProjectsScreen.tsx` — new-project dialog format picker drops markdown + rmarkdown; document-type / experience step removed (one less step)
- `src/screens/settings/SettingsScreen.tsx` — drop rmarkdown/markdown-specific compile settings; engine picker (system-tex / tectonic / busytex) stays
- `src/commands/actions.ts` — `adapterFor()` two-case
- `src/commands/boot.ts` — drop `notebook.runAll` and any RMD-specific bootstrap commands
- `src/commands/keyboard.ts` — drop `Mod+Shift+Enter` (notebook.runAll); other shortcuts unchanged
- `src/stores/editor-store.ts` — drop `consoleLabel()`; callers go back to a hard-coded `"Logs"`
- `src/components/editor/EditorSidebar.tsx`, `FileTree.tsx`, `FormatToolbar.tsx`, `LogsDrawer.tsx`, `ExportMenu.tsx` — strip notebook/rmd/md branches
- `src/components/editor/CodeMirror.tsx` — **no change to the `lang-markdown` import or the `lang === "markdown"` branch**. Markdown CM6 syntax highlighting stays for `.md` files (the deletion is the *adapter*, not the CM6 language). The upstream caller that resolves a `props.language` value (today driven partly by project format) is updated so that `.md` files always resolve to `"markdown"` regardless of project format; LaTeX/Typst files keep their existing routing.
- `src/ipc/index.ts` — drop `notebook.*` IPC wrappers and the rmarkdown compile wrapper
- `src/stores/lsp-store.ts` + `src/lib/lsp/client.ts` — drop marksman server registration; keep texlab + tinymist
- `src/themes/themes/*.css`, `tokens.css`, `density.css`, `motion.css` — strip notebook-specific tokens (cell borders, output backgrounds, console panel colours) that go unused after components are gone. Theme files reference "notebook" by name; verify each token is unreferenced after the deletions before stripping
- `CLAUDE.md` — rewrite the "Architecture seams", "Stack", "Status", "Folder layout", and "Gotchas" sections to reflect the narrowed surface; document the new Markdown preview seam
- `plan.md` — update phase notes

### 5.4 Memory updates

- New: `memory/project_markdown_rmd_dropped.md` recording the 2026-05-20 removal
- Edit: `memory/project_quarto_dropped.md` — the supported-formats list is now "LaTeX, Typst" (Markdown and R Markdown removed from that enumeration)
- Edit: `memory/MEMORY.md` — add the new entry; update the Quarto entry's hook to reflect the narrowed supported-formats list

## 6. Archival document

A companion document `docs/ntb_feature.md` is created (or already exists, per
this change) containing: what was removed, why, file-by-file pointers, the
non-obvious architectural decisions worth re-using (persistent R kernel,
feedback-loop guard, line-mode RMD parser, tablet shell parity), and a
re-introduction sketch. It also records deferred follow-ups (plot/image
capture, Python/Julia kernels).

## 7. Risks

- **Bundle size.** New Markdown preview deps add roughly 320 KB gz. KaTeX
  fonts ship as static woff2; treat them the same way `@fontsource/inter`
  is treated today.
- **DOMPurify config surface.** The `file://` allowlist on `<img src>` is the
  minimum needed for relative image refs. Any future custom plugin (e.g.,
  embedded HTML in fenced blocks) must re-verify the sanitiser config.
- **Theme integration.** KaTeX and code-block CSS need to follow the active
  Typeward theme tokens (`--color-fg-1` etc.); imported KaTeX CSS uses fixed
  colours by default and will need a small override.
- **Test coverage drop.** Roughly 20 tests delete with the notebook code. Net
  test count drops; no replacements needed since the surface they covered no
  longer exists. The Markdown preview gets a small new test for the
  render → sanitise pipeline.

## 8. Verification

- `npm run build` (tsc + vite) clean.
- `npm test` green (notebook tests removed; new MarkdownPreview render test added).
- `cargo test --manifest-path src-tauri/Cargo.toml` green; the `notebook.rs`
  tests are gone with the module.
- Manual: open a LaTeX project, add `NOTES.md` with a heading, a math block,
  a code fence, and a relative image — verify the preview pane swaps when the
  `.md` tab is active and returns to PDF when the root `.tex` tab is active.
- Manual: open a Typst project, repeat.
- Manual: the new-project dialog and onboarding screen no longer offer
  Markdown or R Markdown as project formats.

## 9. Out-of-band cleanup

- `design_files/` HTML/JSX prototypes still reference R Markdown and notebook
  cells. Treat as historical; do not delete them, but flag in `CLAUDE.md`
  that the notebook prototypes are no longer source-of-truth.
- The Tectonic sidecar, busytex assets, and the engine picker are unchanged
  by this work.
