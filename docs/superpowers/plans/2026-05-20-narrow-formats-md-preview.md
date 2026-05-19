# Narrow project formats; live Markdown file preview — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Narrow Typeward's project formats to LaTeX + Typst only and replace Markdown-as-a-project with a live, sandboxed HTML preview for any `.md` file opened inside a LaTeX or Typst project. Remove the R Markdown notebook experience and the persistent R kernel.

**Architecture:** Additive first (new `MarkdownPreview` component wired into the existing text shell's preview pane), then subtractive (delete notebook UI, R kernel, `MarkdownAdapter`, `RmarkdownAdapter`, and their IPC paths in dependency order so the tree compiles after every commit). The Markdown preview is tab-scoped — it swaps the right pane's contents based on the active editor tab's extension, with no changes to `EditorAdapter` or project routing.

**Tech Stack:** Solid + TypeScript + Vite, Tauri 2 + Rust, CodeMirror 6, Vitest (jsdom), Tailwind v4. New deps: `markdown-it`, `markdown-it-katex`, `markdown-it-anchor`, `dompurify`, `katex`.

**Spec:** `docs/superpowers/specs/2026-05-20-narrow-formats-md-preview-design.md`
**Companion (archival):** `docs/ntb_feature.md`

**Working tree:** main. No worktree required — every task ends green so the user can pause at any commit.

---

## File map

**Create:**
- `src/components/preview/MarkdownPreview.tsx`
- `src/components/preview/MarkdownPreview.test.tsx`

**Modify:**
- `src/screens/editor/shells/text-shell.tsx`
- `src/screens/editor/EditorScreen.tsx`
- `src/screens/onboarding/OnboardingScreen.tsx`
- `src/screens/projects/ProjectsScreen.tsx`
- `src/screens/settings/SettingsScreen.tsx`
- `src/components/editor/CodeMirror.tsx`
- `src/components/editor/EditorSidebar.tsx`
- `src/components/editor/FormatToolbar.tsx`
- `src/components/editor/ExportMenu.tsx`
- `src/components/editor/LogsDrawer.tsx`
- `src/commands/actions.ts`
- `src/commands/boot.ts`
- `src/commands/boot.test.ts`
- `src/commands/keyboard.ts`
- `src/stores/editor-store.ts`
- `src/stores/lsp-store.ts`
- `src/lib/lsp/client.ts`
- `src/ipc/index.ts`
- `src/adapters/types.ts`
- `src/adapters/adapter-contract.test.ts`
- `src/themes/tokens.css`
- `src/themes/themes/*.css` (cell-token sweeps; only if unreferenced after deletions)
- `src-tauri/src/lib.rs`
- `src-tauri/src/commands.rs`
- `src-tauri/src/lsp.rs`
- `src-tauri/src/project.rs` (drop `experience` from on-disk schema if present)
- `src-tauri/Cargo.toml` (drop deps only used by `notebook.rs`)
- `CLAUDE.md`
- `plan.md`
- `package.json`

**Delete:**
- `src/experiences/types.ts`
- `src/screens/editor/shells/notebook-shell.tsx`
- `src/components/editor/CellEditor.tsx`
- `src/components/notebook/` (folder)
- `src/adapters/rmarkdown/` (folder)
- `src/adapters/markdown/` (folder)
- `src/stores/notebook-store.ts`
- `src/stores/notebook-store.test.ts`
- `src/stores/notebook-outputs-store.ts`
- `src/lib/notebook/` (folder)
- `src-tauri/src/notebook.rs`

---

### Task 1: Add Markdown preview dependencies

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install runtime deps**

Run:
```
npm install markdown-it markdown-it-katex markdown-it-anchor dompurify katex
```

- [ ] **Step 2: Install type defs**

Run:
```
npm install --save-dev @types/markdown-it @types/markdown-it-katex @types/markdown-it-anchor @types/dompurify
```

If any `@types/*` package above is not published, omit it and rely on the package's bundled types (`markdown-it-katex` historically ships JS only — declare a one-line `declare module "markdown-it-katex"` shim in `src/types/shims.d.ts` if TS complains).

- [ ] **Step 3: Verify install**

Run:
```
npm run build
```

Expected: clean build (no behavioral change yet; new deps unused).

- [ ] **Step 4: Commit**

```
git add package.json package-lock.json src/types/shims.d.ts
git commit -m "deps: add markdown-it, katex, dompurify for md preview"
```

---

### Task 2: Implement MarkdownPreview component (TDD)

**Files:**
- Create: `src/components/preview/MarkdownPreview.tsx`
- Create: `src/components/preview/MarkdownPreview.test.tsx`

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/preview/MarkdownPreview.test.tsx
import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders headings as <h1>", async () => {
    const [content] = createSignal("# Hello\n\nbody");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Hello");
    });
  });

  it("renders inline math via KaTeX", async () => {
    const [content] = createSignal("Energy is $E = mc^2$.");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector(".katex")).not.toBeNull();
    });
  });

  it("strips <script> via DOMPurify", async () => {
    const [content] = createSignal("hello\n\n<script>window.x=1</script>");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector("p")?.textContent).toContain("hello");
    });
    expect(container.querySelector("script")).toBeNull();
  });

  it("rewrites relative <img src> against baseDir", async () => {
    const [content] = createSignal("![alt](./pic.png)");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/proj/sub" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "file:///proj/sub/pic.png",
      );
    });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```
npx vitest run src/components/preview/MarkdownPreview.test.tsx
```

Expected: FAIL — module `./MarkdownPreview` does not exist.

- [ ] **Step 3: Write the implementation**

```tsx
// src/components/preview/MarkdownPreview.tsx
import DOMPurify from "dompurify";
import MarkdownIt from "markdown-it";
import mdAnchor from "markdown-it-anchor";
import mdKatex from "markdown-it-katex";
import type { Accessor, Component } from "solid-js";
import { createEffect, createMemo, onCleanup } from "solid-js";

interface Props {
  content: Accessor<string>;
  baseDir: string;
  theme: Accessor<"dark" | "light">;
}

function buildMd(baseDir: string): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
  })
    .use(mdKatex, { throwOnError: false })
    .use(mdAnchor, { tabIndex: false });

  const rewriteRelative = (url: string): string => {
    if (/^[a-z][a-z0-9+.-]*:/i.test(url)) return url;
    if (url.startsWith("#")) return url;
    const trimmed = url.replace(/^\.?\/+/, "");
    const root = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
    return `file://${root}/${trimmed}`;
  };

  const origImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const srcAttr = token.attrIndex("src");
    if (srcAttr >= 0) {
      token.attrs![srcAttr][1] = rewriteRelative(token.attrs![srcAttr][1]);
    }
    return origImage
      ? origImage(tokens, idx, opts, env, self)
      : self.renderToken(tokens, idx, opts);
  };
  return md;
}

DOMPurify.addHook("afterSanitizeAttributes", (node) => {
  if (node.tagName === "IMG") {
    const src = node.getAttribute("src");
    if (src && src.startsWith("file://")) {
      node.setAttribute("src", src);
    }
  }
});

export const MarkdownPreview: Component<Props> = (props) => {
  const md = createMemo(() => buildMd(props.baseDir));

  let host: HTMLDivElement | undefined;
  let timer: number | null = null;

  const render = (source: string) => {
    if (!host) return;
    const dirty = md().render(source);
    host.innerHTML = DOMPurify.sanitize(dirty, {
      ADD_ATTR: ["target"],
      ALLOWED_URI_REGEXP: /^(?:(?:https?|mailto|tel|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
  };

  createEffect(() => {
    const source = props.content();
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => render(source), 80);
  });

  onCleanup(() => {
    if (timer !== null) window.clearTimeout(timer);
  });

  return (
    <div
      class="md-preview h-full w-full overflow-auto px-8 py-6 text-fg-1"
      classList={{ "md-preview-dark": props.theme() === "dark", "md-preview-light": props.theme() === "light" }}
      ref={host}
    />
  );
};
```

Note: the component assigns `innerHTML` only after an 80 ms debounce, which is why the test uses `waitFor` (default timeout 1 s in `@solidjs/testing-library`).

- [ ] **Step 4: Re-run tests**

Run:
```
npx vitest run src/components/preview/MarkdownPreview.test.tsx
```

Expected: PASS — all four assertions.

- [ ] **Step 5: Import KaTeX CSS once at app root**

Modify: `src/main.tsx` (or wherever global CSS is imported). Add:

```ts
import "katex/dist/katex.min.css";
```

Then run `npm run build` to confirm the bundle still builds.

- [ ] **Step 6: Commit**

```
git add src/components/preview/ src/main.tsx
git commit -m "feat(preview): add MarkdownPreview component (markdown-it + katex + dompurify)"
```

---

### Task 3: Wire MarkdownPreview into text-shell preview pane

**Files:**
- Modify: `src/screens/editor/shells/text-shell.tsx`

- [ ] **Step 1: Add preview Switch in text-shell**

Locate where `<PdfViewer ... />` is rendered as the right-pane content. Replace with a `<Switch>` keyed on the active file's extension. Pseudocode:

```tsx
import { Match, Switch, createMemo } from "solid-js";
import { MarkdownPreview } from "~/components/preview/MarkdownPreview";
import { activeFile, project } from "~/stores/editor-store";
import { activeTheme } from "~/themes/theme-store"; // adjust to actual signal name

const previewKind = createMemo<"markdown" | "pdf">(() => {
  const f = activeFile();
  return f?.relPath.toLowerCase().endsWith(".md") ? "markdown" : "pdf";
});

const mdBaseDir = createMemo<string>(() => {
  const f = activeFile();
  const p = project();
  if (!f || !p) return p?.rootPath ?? "";
  const segs = f.relPath.replace(/\\/g, "/").split("/");
  segs.pop();
  return [p.rootPath.replace(/\\/g, "/"), ...segs].filter(Boolean).join("/");
});

// In the render:
<Switch>
  <Match when={previewKind() === "markdown"}>
    <MarkdownPreview
      content={() => activeFile()!.content}
      baseDir={mdBaseDir()}
      theme={() => /* return "dark" | "light" based on theme store */}
    />
  </Match>
  <Match when={previewKind() === "pdf"}>
    {/* existing <PdfViewer ... /> usage, unchanged */}
  </Match>
</Switch>
```

If `activeTheme` is not the actual signal name, grep `src/themes/theme-store.ts` and use the exported accessor.

- [ ] **Step 2: Verify type-check**

Run:
```
npm run build
```

Expected: clean. If `PdfViewer` props were dependent on the parent's signal closures, ensure they're still resolved inside the `<Match>` branch.

- [ ] **Step 3: Manual smoke test**

Run:
```
npm run tauri dev
```

In a LaTeX project:
1. Create `NOTES.md` with `# Hello\n\nEnergy: $E = mc^2$.\n\n![pic](./pic.png)`.
2. Open `NOTES.md`. Expected: preview pane swaps to rendered markdown with math.
3. Open `main.tex`. Expected: preview pane returns to PDF.
4. Type into `NOTES.md`. Expected: preview re-renders within ~100 ms.

- [ ] **Step 4: Commit**

```
git add src/screens/editor/shells/text-shell.tsx
git commit -m "feat(editor): swap preview pane to MarkdownPreview for .md tabs"
```

---

### Task 4: Remove notebook frontend surface

**Files:**
- Delete: `src/screens/editor/shells/notebook-shell.tsx`
- Delete: `src/components/editor/CellEditor.tsx`
- Delete: `src/components/notebook/` (folder)
- Delete: `src/stores/notebook-store.ts`
- Delete: `src/stores/notebook-store.test.ts`
- Delete: `src/stores/notebook-outputs-store.ts`
- Delete: `src/lib/notebook/` (folder)
- Modify: `src/screens/editor/EditorScreen.tsx`
- Modify: `src/commands/boot.ts`
- Modify: `src/commands/boot.test.ts`
- Modify: `src/commands/keyboard.ts`
- Modify: `src/ipc/index.ts`
- Modify: `src/components/editor/EditorSidebar.tsx`
- Modify: `src/stores/editor-store.ts`

- [ ] **Step 1: Strip notebook routing in EditorScreen**

In `src/screens/editor/EditorScreen.tsx`:
- Find the `<Switch>` that branches on `project().experience`.
- Replace with the unconditional `<TextShell />` (TextShell is the only shell left).
- Remove the `NotebookShell` import and the corresponding `<Match>` branch.
- In `adapterForFormat(format)`, leave it intact for now — the `markdown` and `rmarkdown` cases are removed in later tasks.

- [ ] **Step 2: Drop notebook commands & shortcut**

In `src/commands/boot.ts`: remove `notebook.runAll` and any `notebook.*` command registrations. In `src/commands/keyboard.ts`: remove the `Mod+Shift+Enter` handler.

In `src/commands/boot.test.ts`: remove notebook-related test rows.

- [ ] **Step 3: Drop notebook IPC wrappers**

In `src/ipc/index.ts`: remove the wrappers calling `notebook.run_r_chunk`, `notebook.stop_r_kernel`, `notebook.r_kernel_status`. Keep `compile_rmarkdown` and `compile_markdown` for now (removed in Tasks 6–7).

- [ ] **Step 4: Drop `consoleLabel` from editor-store**

In `src/stores/editor-store.ts`: remove the `consoleLabel()` function and its export. Find callers (likely in `LogsDrawer.tsx`) and replace with the literal string `"Logs"`.

- [ ] **Step 5: Update EditorSidebar comment**

In `src/components/editor/EditorSidebar.tsx` line 27 the JSDoc reads "Shared left sidebar for the editor shells (TextShell, NotebookShell)." — rewrite to "Shared left sidebar for the editor's TextShell."

- [ ] **Step 6: Delete files**

Delete (paths above). On Windows in PowerShell: `Remove-Item -Recurse -Force src\components\notebook` etc.

- [ ] **Step 7: Verify type-check and tests**

Run:
```
npm run build
npm test
```

Expected: clean. The `RmarkdownAdapter` still imports nothing notebook-related (it shells out to `compile_rmarkdown` directly) so it should still compile.

- [ ] **Step 8: Commit**

```
git add -A
git commit -m "refactor: remove notebook UI, cell stores, R-chunk IPC wrappers"
```

---

### Task 5: Remove notebook backend (R kernel + commands)

**Files:**
- Delete: `src-tauri/src/notebook.rs`
- Modify: `src-tauri/src/lib.rs`
- Modify: `src-tauri/Cargo.toml`

- [ ] **Step 1: Strip notebook module from lib.rs**

In `src-tauri/src/lib.rs`:
- Remove `mod notebook;` (line ~6).
- Remove `.manage(notebook::KernelManager::default())` from the builder chain (line ~26).
- Remove `notebook::run_r_chunk`, `notebook::stop_r_kernel`, `notebook::r_kernel_status` from the `invoke_handler!` registration (lines ~43–45).
- **Keep** `commands::compile_markdown` and `commands::compile_rmarkdown` for now — they go in Tasks 6–7.

- [ ] **Step 2: Delete notebook.rs**

```
Remove-Item src-tauri\src\notebook.rs
```

- [ ] **Step 3: Drop notebook-only crate deps**

Inspect `notebook.rs`'s previous `use` lines via `git show HEAD:src-tauri/src/notebook.rs | head -40`. Any crate referenced only there can be removed from `[dependencies]` in `src-tauri/Cargo.toml`. Common suspects: nothing project-specific; the persistent kernel used only `tokio`, `tauri`, `serde`, all of which other modules still use. Verify with `cargo check` after removal.

- [ ] **Step 4: Verify cargo build**

Run:
```
cargo check --manifest-path src-tauri/Cargo.toml
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: clean.

- [ ] **Step 5: Commit**

```
git add src-tauri/
git commit -m "refactor: remove notebook.rs and R kernel manager"
```

---

### Task 6: Remove RmarkdownAdapter and compile_rmarkdown

**Files:**
- Delete: `src/adapters/rmarkdown/` (folder)
- Modify: `src/commands/actions.ts`
- Modify: `src/screens/editor/EditorScreen.tsx`
- Modify: `src/adapters/adapter-contract.test.ts`
- Modify: `src/ipc/index.ts`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Drop rmarkdown branch from adapterFor**

In `src/commands/actions.ts` near the top:
```ts
const adapterFor = (p: Project): EditorAdapter | null => {
  if (p.format === "latex") return LatexAdapter;
  if (p.format === "markdown") return MarkdownAdapter;
  if (p.format === "typst") return TypstAdapter;
  return null;
};
```
Also remove the `RmarkdownAdapter` import.

- [ ] **Step 2: Drop rmarkdown branch from adapterForFormat**

In `src/screens/editor/EditorScreen.tsx`: remove the `rmarkdown` branch and `RmarkdownAdapter` import.

- [ ] **Step 3: Update contract tests**

In `src/adapters/adapter-contract.test.ts`: remove the `RmarkdownAdapter` row from the parametric `it.each` / `describe.each` table.

- [ ] **Step 4: Delete the adapter folder**

```
Remove-Item -Recurse -Force src\adapters\rmarkdown
```

- [ ] **Step 5: Drop compile_rmarkdown IPC wrapper**

In `src/ipc/index.ts`: remove the `compileRmarkdown` wrapper.

- [ ] **Step 6: Drop compile_rmarkdown in Rust**

In `src-tauri/src/commands.rs`: delete the `compile_rmarkdown` function and any helpers (e.g., `parse_rmarkdown_log`) that are no longer referenced. In `src-tauri/src/lib.rs`: remove `commands::compile_rmarkdown` from `invoke_handler!`.

- [ ] **Step 7: Verify**

Run:
```
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: clean.

- [ ] **Step 8: Commit**

```
git add -A
git commit -m "refactor: remove RmarkdownAdapter and compile_rmarkdown"
```

---

### Task 7: Remove MarkdownAdapter and compile_markdown

**Files:**
- Delete: `src/adapters/markdown/` (folder)
- Modify: `src/commands/actions.ts`
- Modify: `src/screens/editor/EditorScreen.tsx`
- Modify: `src/adapters/adapter-contract.test.ts`
- Modify: `src/ipc/index.ts`
- Modify: `src-tauri/src/commands.rs`
- Modify: `src-tauri/src/lib.rs`

- [ ] **Step 1: Drop markdown branch from adapterFor**

In `src/commands/actions.ts`:
```ts
const adapterFor = (p: Project): EditorAdapter | null => {
  if (p.format === "latex") return LatexAdapter;
  if (p.format === "typst") return TypstAdapter;
  return null;
};
```
Remove the `MarkdownAdapter` import.

- [ ] **Step 2: Drop markdown branch from adapterForFormat**

In `src/screens/editor/EditorScreen.tsx`: remove the `markdown` branch and `MarkdownAdapter` import.

- [ ] **Step 3: Drop markdown row from adapter-contract.test.ts**

Same pattern as Task 6 step 3.

- [ ] **Step 4: Delete the adapter folder and IPC wrapper**

```
Remove-Item -Recurse -Force src\adapters\markdown
```

In `src/ipc/index.ts`: remove `compileMarkdown`.

- [ ] **Step 5: Drop compile_markdown in Rust**

In `src-tauri/src/commands.rs`: delete `compile_markdown`. In `src-tauri/src/lib.rs`: remove `commands::compile_markdown` from `invoke_handler!`.

- [ ] **Step 6: Verify**

Run:
```
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: clean.

- [ ] **Step 7: Commit**

```
git add -A
git commit -m "refactor: remove MarkdownAdapter and compile_markdown"
```

---

### Task 8: Narrow ProjectFormat and EditorAdapter; drop Project.experience

**Files:**
- Modify: `src/adapters/types.ts`
- Delete: `src/experiences/types.ts`
- Modify: `src/screens/editor/EditorScreen.tsx`
- Modify: `src-tauri/src/project.rs`
- Modify: any file still importing `DocumentExperience` or referencing `Project.experience`

- [ ] **Step 1: Narrow ProjectFormat in TS**

In `src/adapters/types.ts`:

```ts
export type ProjectFormat = "latex" | "typst";

export interface Project {
  rootPath: string;
  rootFile: string;
  format: ProjectFormat;
  name: string;
}

export interface EditorAdapter {
  languageId: string;
  format: ProjectFormat;
  previewKind: "pdf";
  cmExtensions(): CodeMirrorExtension[];
  compile(project: Project): Promise<CompileResult>;
  commands: EditorCommand[];
}
```

Note the dropped `experience` field and the narrowed `previewKind`.

- [ ] **Step 2: Delete experiences/types.ts**

```
Remove-Item src\experiences\types.ts
Remove-Item -Recurse -Force src\experiences   # if folder empty
```

- [ ] **Step 3: Resolve TS errors**

Run `npm run build` and fix every reported error. Expected sites (already de-noticed in earlier tasks but worth re-checking):
- `EditorScreen.tsx` — any remaining `project().experience` reads → remove.
- Any test fixture that constructs a `Project` with `experience: "text"` → drop the field.

- [ ] **Step 4: Narrow ProjectFormat on the Rust side**

In `src-tauri/src/project.rs`:
- Narrow the `ProjectFormat` enum to `Latex` and `Typst`.
- Remove the `experience` field from the Rust `Project` struct (and any serde alias) if present.
- If the on-disk JSON still contains an `experience` key, use `#[serde(default)] #[serde(skip_serializing_if = "Option::is_none")]` on a transitional `_experience: Option<String>` field or use `#[serde(other)]`. Simpler: just deserialize with `#[serde(deny_unknown_fields)]` off so the legacy key is ignored.

- [ ] **Step 5: Verify**

Run:
```
npm run build
npm test
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: clean.

- [ ] **Step 6: Commit**

```
git add -A
git commit -m "refactor(types): narrow ProjectFormat to latex|typst; drop DocumentExperience"
```

---

### Task 9: Update OnboardingScreen

**Files:**
- Modify: `src/screens/onboarding/OnboardingScreen.tsx`

- [ ] **Step 1: Narrow FormatOption.id and prune FORMATS**

```ts
interface FormatOption {
  id: "latex" | "typst";
  name: string;
  glyph: string;
  desc: string;
  color: string;
  size: string;
  engine: string;
  recommended?: boolean;
}

const FORMATS: FormatOption[] = [
  {
    id: "latex",
    name: "LaTeX",
    glyph: "τ",
    desc: "Mathematical typesetting · papers, theses",
    color: "#A78BFA",
    size: "4.2 GB",
    engine: "TeX Live · pdflatex / xelatex / lualatex",
    recommended: true,
  },
  {
    id: "typst",
    name: "Typst",
    glyph: "§",
    desc: "Modern compile-fast alternative to LaTeX",
    color: "#67E8F9",
    size: "62 MB",
    engine: "typst CLI · v0.13",
    recommended: true,
  },
];
```

- [ ] **Step 2: Update default picked set and pills**

```ts
const [picked, setPicked] = createSignal<Set<FormatOption["id"]>>(
  new Set(["latex"]),
);

const FORMAT_PILLS = [
  { icon: Sigma, label: "LaTeX" },
  { icon: Package, label: "Typst" },
];
```

Remove the `Hash` import if it becomes unused.

- [ ] **Step 3: Update InstallPane tasks**

In `InstallPane`'s `tasks` memo, drop the `pandoc` row (no longer needed). Keep `tex` and `typst`.

- [ ] **Step 4: Verify and manual test**

Run `npm run tauri dev` and walk the onboarding flow with a fresh `onboarded: false` state (clear it in Settings or in localStorage). Expected: only LaTeX + Typst appear.

- [ ] **Step 5: Commit**

```
git add src/screens/onboarding/
git commit -m "ui(onboarding): drop markdown/rmarkdown from format picker"
```

---

### Task 10: Update ProjectsScreen new-project flow

**Files:**
- Modify: `src/screens/projects/ProjectsScreen.tsx`

- [ ] **Step 1: Drop markdown/rmarkdown from format picker**

Grep the file for `"markdown"`, `"rmarkdown"`, and any `experience` references in the new-project dialog. Remove those branches and array entries. The format picker should offer LaTeX and Typst only.

- [ ] **Step 2: Remove the document-type / experience step**

If the new-project flow has a "what kind of doc" step (text vs notebook), delete it. The remaining flow is: name → folder → format → create.

- [ ] **Step 3: Update project creation IPC payload**

If `createProject` IPC accepts `experience`, drop the argument and update the Rust handler in lockstep (already done in Task 8 step 4).

- [ ] **Step 4: Manual test**

Create a fresh LaTeX project from the dialog. Then a Typst one. Expected: both open in the text shell with a working PDF preview pane.

- [ ] **Step 5: Commit**

```
git add src/screens/projects/
git commit -m "ui(projects): drop markdown/rmarkdown formats and experience step"
```

---

### Task 11: Update SettingsScreen, FormatToolbar, ExportMenu, LogsDrawer

**Files:**
- Modify: `src/screens/settings/SettingsScreen.tsx`
- Modify: `src/components/editor/FormatToolbar.tsx`
- Modify: `src/components/editor/ExportMenu.tsx`
- Modify: `src/components/editor/LogsDrawer.tsx`

- [ ] **Step 1: SettingsScreen — drop md/rmd compile-engine controls**

Grep `SettingsScreen.tsx` for `markdown` and `rmarkdown`. Remove any controls (compile-engine selector branches, pandoc-related toggles, R-engine path inputs). Keep the LaTeX engine selector (system-tex / tectonic / busytex) and Typst settings.

- [ ] **Step 2: FormatToolbar — drop md/rmd toolbar rows**

In `src/components/editor/FormatToolbar.tsx`, the format-keyed map currently has `markdown:` (line ~57) and `rmarkdown:` (line ~72) entries. Delete both blocks. Update the JSDoc on line ~158 from "(LaTeX / Markdown / RMarkdown / Typst)" to "(LaTeX / Typst)".

- [ ] **Step 3: ExportMenu — drop Markdown export entry**

In `src/components/editor/ExportMenu.tsx` line 40 the array contains `{ id: "md", label: "Markdown", hint: "Pandoc → .md", icon: ... }`. Remove this entry — exporting a project (LaTeX or Typst) to Markdown is not in scope.

- [ ] **Step 4: LogsDrawer — verify "Console" branch is dead**

After Task 4 step 4 (`consoleLabel` removed), `LogsDrawer.tsx` should already use a literal `"Logs"` heading. Re-verify: no `rmarkdown` or `Console` branches remain.

- [ ] **Step 5: Verify**

Run `npm run build` and `npm test`. Expected: clean.

- [ ] **Step 6: Commit**

```
git add src/screens/settings/ src/components/editor/
git commit -m "ui(editor): drop md/rmd toolbar, settings, and export entries"
```

---

### Task 12: Update CodeMirror language resolver and drop marksman

**Files:**
- Modify: `src/components/editor/CodeMirror.tsx`
- Modify: `src/stores/lsp-store.ts`
- Modify: `src/lib/lsp/client.ts`
- Modify: `src-tauri/src/lsp.rs`

- [ ] **Step 1: File-extension-driven language resolution**

The `langExtension` switch in `src/components/editor/CodeMirror.tsx` (line ~108) already maps `"markdown" -> markdown()`. Trace the upstream caller that sets `props.language` (likely in `text-shell.tsx` where CodeMirror is mounted) and change the resolution so:

```ts
function languageFor(relPath: string, projectFormat: ProjectFormat): "latex" | "typst" | "markdown" | "plain" {
  const ext = relPath.toLowerCase().split(".").pop() ?? "";
  if (ext === "md") return "markdown";
  if (ext === "typ") return "typst";
  if (ext === "tex" || ext === "cls" || ext === "sty" || ext === "bib") return "latex";
  return "plain";
}
```

Use this helper at the CodeMirror mount site. Now `.md` files inside a LaTeX project still get markdown highlighting.

- [ ] **Step 2: Drop "markdown" from LspLanguage**

In `src/stores/lsp-store.ts` line 6:
```ts
export type LspLanguage = "latex" | "typst";
```
Remove the marksman-related entries (server config, startup wiring). In `src/lib/lsp/client.ts`: drop any marksman registration line.

- [ ] **Step 3: Drop marksman branch in Rust LSP**

In `src-tauri/src/lsp.rs` line 75 the match contains:
```rust
"markdown" => Ok("marksman"),
```
Remove this arm. Verify no other `marksman` references remain (`grep -i marksman src-tauri/src/`).

- [ ] **Step 4: Verify**

Run:
```
npm run build
cargo test --manifest-path src-tauri/Cargo.toml
```

Expected: clean. Manual: open a `.md` file in a LaTeX project — syntax highlighting works, no LSP errors logged.

- [ ] **Step 5: Commit**

```
git add -A
git commit -m "refactor(lsp): drop marksman; route .md via file-ext"
```

---

### Task 13: Strip orphaned theme tokens

**Files:**
- Modify: `src/themes/tokens.css`
- Modify: `src/themes/themes/obsidian.css`, `graphite.css`, `paper.css`, `solarized-light.css`, `mono.css`
- Modify: `src/themes/density.css`
- Modify: `src/themes/motion.css`

- [ ] **Step 1: Confirm orphaned token names**

Run from repo root:
```
npx grep --type=ts --type=tsx --type=css "format-markdown\|format-rmarkdown\|notebook\|cell-output\|cell-border" -r src/ | grep -v "^src/themes/"
```

Any line in the output identifies a still-live consumer; investigate before deleting that token. (Use Grep tool in Claude harness; the literal `grep` command above is illustrative.)

- [ ] **Step 2: Remove tokens with zero consumers**

In `src/themes/tokens.css` (line ~81–82): `--format-markdown` and `--format-rmarkdown` are referenced only in FormatToolbar (already gutted) — delete both.

Sweep each theme file for tokens named `*cell*`, `*notebook*`, `*console*` (cell output gutter colours, the console panel background, the kernel-running indicator); delete any with no current consumer. Leave anything ambiguous in place — a stale CSS variable is harmless.

- [ ] **Step 3: Verify**

Run `npm run build`. Expected: clean.

- [ ] **Step 4: Commit**

```
git add src/themes/
git commit -m "style(themes): drop orphaned notebook/markdown tokens"
```

---

### Task 14: Update CLAUDE.md and plan.md

**Files:**
- Modify: `CLAUDE.md`
- Modify: `plan.md`

- [ ] **Step 1: CLAUDE.md edits**

- Top blurb: change "format-agnostic: LaTeX, Typst, Markdown, R Markdown" to "format-agnostic: LaTeX, Typst, with live `.md` file preview".
- "Architecture seams" section: drop the `DocumentExperience` paragraph; drop the persistent R kernel paragraph; drop the notebook shell paragraph. Replace with: "Markdown files — when the active tab is `.md`, the right pane renders via `src/components/preview/MarkdownPreview.tsx` (markdown-it + KaTeX + DOMPurify); see `docs/superpowers/specs/2026-05-20-narrow-formats-md-preview-design.md` and `docs/ntb_feature.md`."
- `EditorAdapter` paragraph: drop "Four concrete impls" — now two: `LatexAdapter`, `TypstAdapter`. Update the "format → adapter mapping" sentence to "Two concrete impls today".
- Gotchas: drop the markdown-needs-LaTeX-engine note and the persistent-R-kernel note. Keep all other gotchas.
- Stack: drop pandoc + R from the engine list.
- Folder layout block: drop `notebook-shell.tsx`, `experiences/`, `adapters/rmarkdown`, `adapters/markdown`, `lib/notebook/`, `stores/notebook-*`, `components/notebook/`, `notebook.rs`.
- Status: append a Phase 5 (or amend Phase 4) entry noting the 2026-05-20 narrowing.

- [ ] **Step 2: plan.md edits**

Skim `plan.md`. Strike any references to Quarto, R Markdown, Markdown-as-project, notebook experience, or persistent R kernel. Replace with a one-paragraph "Scope narrowing — 2026-05-20" block summarising the change and pointing to the spec.

- [ ] **Step 3: Commit**

```
git add CLAUDE.md plan.md
git commit -m "docs: update CLAUDE.md and plan.md for format narrowing"
```

---

### Task 15: Final verification

**Files:** none

- [ ] **Step 1: Full frontend build**

Run:
```
npm run build
```
Expected: clean.

- [ ] **Step 2: Full frontend tests**

Run:
```
npm test
```
Expected: all green. Notebook tests (~20) have been removed; new MarkdownPreview tests pass.

- [ ] **Step 3: Full Rust tests**

Run:
```
cargo test --manifest-path src-tauri/Cargo.toml
```
Expected: clean.

- [ ] **Step 4: Manual end-to-end**

Run `npm run tauri dev`. Verify:
- Onboarding shows LaTeX + Typst only.
- New-project dialog shows LaTeX + Typst only and has no document-type step.
- Create a LaTeX project, add `NOTES.md`, open it — preview pane shows rendered markdown.
- Switch back to `main.tex` — preview returns to PDF.
- Create a Typst project, add `README.md`, open it — preview swaps. Type into the markdown file — preview re-renders within ~100 ms.
- Settings → Editor → Compilation: only LaTeX engine + Typst settings remain.
- Mod+Shift+Enter does nothing (no notebook.runAll handler).
- Logs panel header reads "Logs" (not "Console").

- [ ] **Step 5: Final tag/commit if needed**

If any verification step revealed a leftover reference, fix it and commit before declaring done.

```
git log --oneline -20   # sanity-check the commit series
```

---

## Self-review notes (for the implementer)

- **Spec coverage:** every section of the spec maps to a task here. Section 3 → Task 2 + 3. Section 4 → Task 8. Section 5.1 → Tasks 4 + 6 + 7. Section 5.2 → Task 5 + 12. Section 5.3 → Tasks 4 + 6 + 7 + 8 + 9 + 10 + 11 + 12 + 13 + 14. Section 5.4 (memory) — already done by the design phase; no task needed. Section 6 → Task 14 (companion `docs/ntb_feature.md` was written during design).
- **Commit boundaries:** every task ends with the tree compiling and tests passing. The user can pause after any commit.
- **Order rationale:** Tasks 1–3 are additive (feature still on). Tasks 4–7 remove consumers leaf-first (notebook UI → notebook IPC → notebook backend → rmd adapter → md adapter), so the type narrowing in Task 8 has no remaining call sites to break. Tasks 9–13 are UI sweeps. Task 14 is docs. Task 15 is verification.
- **Risks recapped:** new deps add ~320 KB gz; KaTeX CSS must be imported once at app root (Task 2 step 5); DOMPurify config allows `file://` only on `<img src>`.
