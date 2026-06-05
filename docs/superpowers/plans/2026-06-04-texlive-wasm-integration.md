# Typeward texlive-wasm Integration — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace `texlyre-busytex` with Typeward's own `texlive-wasm` as the LaTeX compile engine on Android/iOS, with the engine bundled in the APK/IPA for fully offline operation.

**Architecture:** The `CompileEngine` type adds `"texlive-wasm"` and drops `"busytex"`. A new provider calls `latexmk()` from `texlive-wasm` with TauriFS reading bundled assets. On mobile the engine auto-locks; desktop keeps system-tex/tectonic unchanged. SyncTeX branches between JS parser (mobile) and CLI shell-out (desktop).

**Tech Stack:** `texlive-wasm` (local dep), `@tauri-apps/plugin-fs`, `@tauri-apps/plugin-os`, SolidJS, Tauri 2.

**Spec:** `docs/superpowers/specs/2026-06-04-texlive-wasm-integration-design.md`

---

## File Structure

```
New files:
  src/providers/compile/texlive-wasm-provider.ts  — compile provider using latexmk() API
  src/lib/platform.ts                             — isMobilePlatform() helper

Modified files:
  package.json                            — swap texlyre-busytex → texlive-wasm
  src/stores/settings-store.ts            — CompileEngine type, migration, platform default
  src/adapters/latex/LatexAdapter.ts      — route to new provider
  src/commands/actions.ts                 — SyncTeX branching stub
  src/screens/settings/SettingsScreen.tsx  — hide engine picker on mobile, remove busytex badge
  src/components/editor/EditorSidebar.tsx  — ENGINE_LABEL update
  src-tauri/tauri.conf.json               — add texlive-wasm resources

Removed files:
  src/providers/compile/busytex-provider.ts
```

---

### Task 1: Dependency swap

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove texlyre-busytex and add texlive-wasm**

In `package.json`, replace the `texlyre-busytex` dependency (line 48):

Remove:
```json
"texlyre-busytex": "^1.1.1",
```

Add:
```json
"texlive-wasm": "file:../texlive-wasm",
```

- [ ] **Step 2: Install**

```bash
npm install
```

Expected: clean install, `texlive-wasm` symlinked from `../texlive-wasm`.

- [ ] **Step 3: Verify the import resolves**

```bash
node -e "import('texlive-wasm').then(m => console.log(Object.keys(m))).catch(e => console.error(e))"
```

Expected: prints export names (createEngine, latexmk, PdfLatex, etc.) or a known ESM error in CJS context (acceptable — Vite handles the import at build time).

---

### Task 2: Platform detection helper

**Files:**
- Create: `src/lib/platform.ts`

- [ ] **Step 1: Create the platform helper**

```ts
// src/lib/platform.ts
let _mobile: boolean | null = null;

export function isMobilePlatform(): boolean {
  if (_mobile !== null) return _mobile;
  try {
    const ua = navigator.userAgent || "";
    _mobile = /Android|iPad|iPhone/i.test(ua);
  } catch {
    _mobile = false;
  }
  return _mobile;
}
```

This uses the user agent rather than `@tauri-apps/plugin-os` to avoid an async call in the settings load path (which is synchronous). The UA check is sufficient for the three targets (Android, iPadOS via iPad UA, iOS via iPhone UA). If the app later needs precise OS detection, this can be upgraded to use the Tauri plugin.

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit 2>&1 | grep -i "platform" | head -5
```

Expected: no errors.

---

### Task 3: CompileEngine type + settings migration

**Files:**
- Modify: `src/stores/settings-store.ts:41` (CompileEngine type)
- Modify: `src/stores/settings-store.ts:78` (default)
- Modify: `src/stores/settings-store.ts:92` (load path)

- [ ] **Step 1: Update CompileEngine type**

At line 41, change:

```ts
export type CompileEngine = "system-tex" | "tectonic" | "busytex";
```

to:

```ts
export type CompileEngine = "system-tex" | "tectonic" | "texlive-wasm";
```

- [ ] **Step 2: Add platform import and migration function**

At the top of the file (after existing imports), add:

```ts
import { isMobilePlatform } from "~/lib/platform";
```

Before the signal declarations (before line 74), add:

```ts
function migrateCompileEngine(raw: string): CompileEngine {
  if (raw === "busytex") {
    return isMobilePlatform() ? "texlive-wasm" : "system-tex";
  }
  if (raw === "texlive-wasm" && !isMobilePlatform()) {
    return "system-tex";
  }
  if (raw === "system-tex" || raw === "tectonic" || raw === "texlive-wasm") {
    return raw;
  }
  return isMobilePlatform() ? "texlive-wasm" : "system-tex";
}
```

- [ ] **Step 3: Update default engine**

At line 78, change:

```ts
const [compileEngine, setCompileEngine] = createSignal<CompileEngine>("system-tex");
```

to:

```ts
const [compileEngine, setCompileEngine] = createSignal<CompileEngine>(
  isMobilePlatform() ? "texlive-wasm" : "system-tex",
);
```

- [ ] **Step 4: Wire migration into settings load**

At line 92, change:

```ts
setCompileEngine(s.compileEngine as CompileEngine);
```

to:

```ts
setCompileEngine(migrateCompileEngine(s.compileEngine));
```

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -c "error"
```

Expected: 0 (or only pre-existing errors unrelated to settings-store).

---

### Task 4: New compile provider

**Files:**
- Create: `src/providers/compile/texlive-wasm-provider.ts`

- [ ] **Step 1: Create the provider**

```ts
// src/providers/compile/texlive-wasm-provider.ts
import { readDir, type DirEntry } from "@tauri-apps/plugin-fs";
import type { CompileResult, Project } from "~/adapters/types";
import * as ipc from "~/ipc";

let configPromise: Promise<object> | null = null;

async function getEngineConfig(): Promise<object> {
  if (configPromise) return configPromise;
  configPromise = (async () => {
    const { withTauriFs } = await import("texlive-wasm/tauri");
    const { BaseDirectory } = await import("@tauri-apps/plugin-fs");
    const vfs = await withTauriFs({
      texmfRoot: "texlive-wasm/texmf",
      baseDir: BaseDirectory.Resource,
    });
    return { vfs };
  })();
  return configPromise;
}

const TEXT_EXTS = new Set([
  ".tex", ".bib", ".cls", ".sty", ".bst", ".def",
  ".ldf", ".fd", ".cnf", ".clo", ".aux",
]);

const BINARY_EXTS = new Set([
  ".png", ".jpg", ".jpeg", ".pdf", ".gif", ".eps",
]);

const SKIP_DIRS = new Set([
  ".typeward", ".git", ".svn", ".hg",
  "node_modules", "build", "out", "dist",
]);

interface AdditionalFile {
  path: string;
  content: string | Uint8Array;
}

const joinPath = (parent: string, ...rest: string[]): string => {
  const useBackslash = parent.includes("\\");
  const sep = useBackslash ? "\\" : "/";
  return [parent, ...rest]
    .map((p) => p.replace(/[\/\\]+$/g, ""))
    .join(sep);
};

const replaceExt = (filename: string, newExt: string): string => {
  const dot = filename.lastIndexOf(".");
  if (dot < 0) return `${filename}.${newExt}`;
  return `${filename.slice(0, dot)}.${newExt}`;
};

async function collectProjectFiles(
  rootPath: string,
  rootRelFile: string,
): Promise<AdditionalFile[]> {
  const collected: AdditionalFile[] = [];
  const queue: { abs: string; rel: string }[] = [{ abs: rootPath, rel: "" }];
  let totalBytes = 0;
  const FILE_CAP = 200;
  const BYTE_CAP = 10 * 1024 * 1024;

  while (queue.length > 0 && collected.length < FILE_CAP) {
    const { abs, rel } = queue.shift()!;
    let entries: DirEntry[];
    try {
      entries = await readDir(abs);
    } catch {
      continue;
    }
    for (const e of entries) {
      if (!e.name) continue;
      if (e.name.startsWith(".") && e.name !== ".typeward") continue;
      if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;

      const childAbs = joinPath(abs, e.name);
      const childRel = rel ? `${rel}/${e.name}` : e.name;

      if (e.isDirectory) {
        queue.push({ abs: childAbs, rel: childRel });
        continue;
      }

      if (childRel === rootRelFile) continue;

      const dot = e.name.lastIndexOf(".");
      const ext = dot >= 0 ? e.name.slice(dot).toLowerCase() : "";
      const isText = TEXT_EXTS.has(ext);
      const isBinary = !isText && BINARY_EXTS.has(ext);
      if (!isText && !isBinary) continue;

      let content: string | Uint8Array;
      let size: number;
      try {
        if (isText) {
          const text = await ipc.readProjectTextFile(rootPath, childRel);
          content = text;
          size = text.length;
        } else {
          const bytes = await ipc.readProjectBinaryFile(rootPath, childRel);
          content = bytes;
          size = bytes.byteLength;
        }
      } catch {
        continue;
      }
      totalBytes += size;
      if (totalBytes > BYTE_CAP) return collected;
      collected.push({ path: childRel, content });
      if (collected.length >= FILE_CAP) break;
    }
  }
  return collected;
}

export async function compileWithTexliveWasm(
  project: Project,
): Promise<CompileResult> {
  const started = performance.now();

  let input: string;
  try {
    input = await ipc.readProjectTextFile(project.rootPath, project.rootFile);
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{
        severity: "error",
        message: `failed to read ${project.rootFile}: ${String(e)}`,
        file: project.rootFile,
        line: 1,
      }],
      log: String(e),
      durationMs: Math.round(performance.now() - started),
    };
  }

  let additionalFiles: AdditionalFile[] = [];
  try {
    additionalFiles = await collectProjectFiles(project.rootPath, project.rootFile);
  } catch {
    additionalFiles = [];
  }

  const files = [
    { path: project.rootFile, content: input },
    ...additionalFiles,
  ];

  let result: { success: boolean; pdf?: Uint8Array; synctex?: Uint8Array; log: string; exitCode: number };
  try {
    const { latexmk } = await import("texlive-wasm");
    const config = await getEngineConfig();
    const r = await latexmk({
      engine: "pdflatex",
      mainTex: project.rootFile,
      files,
      bibtex: "auto",
      makeindex: "auto",
      rerun: "auto",
      ...config,
    });
    result = r;
  } catch (e) {
    return {
      ok: false,
      diagnostics: [{
        severity: "error",
        message: `texlive-wasm threw: ${String(e instanceof Error ? e.message : e)}`,
        file: project.rootFile,
        line: 1,
      }],
      log: String(e instanceof Error ? e.stack ?? e.message : e),
      durationMs: Math.round(performance.now() - started),
    };
  }

  let outputPath: string | undefined;
  if (result.success && result.pdf) {
    const buildRelDir = joinPath(".typeward", "build");
    const outputRelPath = joinPath(buildRelDir, replaceExt(project.rootFile, "pdf"));
    outputPath = joinPath(project.rootPath, outputRelPath);
    try {
      await ipc.writeProjectBinaryFile(project.rootPath, outputRelPath, result.pdf);
    } catch (e) {
      return {
        ok: false,
        diagnostics: [{
          severity: "error",
          message: `compile succeeded but writing the PDF to disk failed: ${String(e)}`,
          file: project.rootFile,
          line: 1,
        }],
        log: result.log,
        durationMs: Math.round(performance.now() - started),
      };
    }

    if (result.synctex && result.synctex.byteLength > 0) {
      const isGzipped =
        result.synctex.byteLength >= 2 &&
        result.synctex[0] === 0x1f &&
        result.synctex[1] === 0x8b;
      const synctexRelPath = joinPath(
        buildRelDir,
        replaceExt(project.rootFile, isGzipped ? "synctex.gz" : "synctex"),
      );
      try {
        await ipc.writeProjectBinaryFile(project.rootPath, synctexRelPath, result.synctex);
      } catch { /* soft fail */ }
    }
  }

  let diagnostics: CompileResult["diagnostics"] = [];
  try {
    const parsed = await ipc.parseLatexLog(result.log, project.rootFile);
    diagnostics = parsed.map((d) => ({
      severity: d.severity,
      message: d.message,
      file: d.file,
      line: d.line,
    }));
  } catch { /* best-effort */ }

  return {
    ok: result.success,
    outputPath,
    diagnostics,
    log: result.log,
    durationMs: Math.round(performance.now() - started),
  };
}
```

- [ ] **Step 2: Verify it compiles**

```bash
npx tsc --noEmit 2>&1 | grep -i "texlive-wasm-provider" | head -10
```

Expected: no type errors from this file (there may be import resolution issues if texlive-wasm types aren't perfectly aligned — fix any that arise).

---

### Task 5: Wire adapter routing

**Files:**
- Modify: `src/adapters/latex/LatexAdapter.ts:11-21`

- [ ] **Step 1: Update the compile dispatch**

Replace lines 11-21:

```ts
const compile = async (project: Project): Promise<CompileResult> => {
  const engine = compileEngine();
  if (engine === "busytex") {
    // Lazy import keeps the ~32MB texlyre-busytex bridge out of the desktop
    // bundle when the user is on system-tex or tectonic.
    const { compileWithBusytex } = await import(
      "~/providers/compile/busytex-provider"
    );
    return compileWithBusytex(project);
  }
  return ipc.compileLatex(project, engine);
};
```

with:

```ts
const compile = async (project: Project): Promise<CompileResult> => {
  const engine = compileEngine();
  if (engine === "texlive-wasm") {
    const { compileWithTexliveWasm } = await import(
      "~/providers/compile/texlive-wasm-provider"
    );
    return compileWithTexliveWasm(project);
  }
  return ipc.compileLatex(project, engine);
};
```

- [ ] **Step 2: Update the command subtitle**

At line 36, change:

```ts
subtitle: "latexmk / pdflatex via system TeX, Tectonic, or busytex (WASM)",
```

to:

```ts
subtitle: "latexmk / pdflatex via system TeX, Tectonic, or TeX Live WASM",
```

- [ ] **Step 3: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -i "LatexAdapter" | head -5
```

Expected: no errors.

---

### Task 6: Settings UI — hide engine picker on mobile, remove busytex badge

**Files:**
- Modify: `src/screens/settings/SettingsScreen.tsx`

- [ ] **Step 1: Add platform import**

Near the top imports, add:

```ts
import { isMobilePlatform } from "~/lib/platform";
```

- [ ] **Step 2: Update ENGINE_LABEL map**

At lines 668-672, change:

```ts
const ENGINE_LABEL: Record<CompileEngine, string> = {
  "system-tex": "System TeX",
  tectonic: "Tectonic",
  busytex: "busytex (WASM)",
};
```

to:

```ts
const ENGINE_LABEL: Record<CompileEngine, string> = {
  "system-tex": "System TeX",
  tectonic: "Tectonic",
  "texlive-wasm": "TeX Live (WASM)",
};
```

- [ ] **Step 3: Wrap engine picker in platform guard**

Wrap the engine picker Row (lines 717-729) with a `Show`:

```tsx
<Show when={!isMobilePlatform()}>
  <Row
    label="Default engine"
    hint="System TeX uses your local install; Tectonic is a self-contained Rust binary."
  >
    <SelectStub
      value={ENGINE_LABEL[compileEngine()]}
      options={[
        { value: "system-tex" as CompileEngine, label: "System TeX" },
        { value: "tectonic" as CompileEngine, label: "Tectonic" },
      ]}
      onChange={(v) => setCompileEngine(v as CompileEngine)}
    />
  </Row>
</Show>
```

- [ ] **Step 4: Remove the busytex install-status badge**

Delete the entire block at lines 731-738:

```tsx
<Show when={isTabletViewport() && compileEngine() === "busytex"}>
  <Row
    label="busytex assets"
    hint="One-time ~120MB download of WASM + TeX Live data. Lives under public/core/busytex/."
  >
    <BusytexAssetsBadge state={busytexAssetsState()} />
  </Row>
</Show>
```

Also remove:
- The `busytexAssetsState` signal and `setBusytexAssetsState` (around line 683)
- The `onMount` HEAD-probe block at lines 686-696
- The `BusytexAssetsBadge` component (lines 793-830)

- [ ] **Step 5: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -i "SettingsScreen\|busytex" | head -10
```

Expected: no errors; no remaining `busytex` references in the file.

---

### Task 7: EditorSidebar ENGINE_LABEL update

**Files:**
- Modify: `src/components/editor/EditorSidebar.tsx:23-27`

- [ ] **Step 1: Update the label map**

Change:

```ts
const ENGINE_LABEL: Record<string, string> = {
  "system-tex": "pdflatex",
  tectonic: "Tectonic (xelatex)",
  busytex: "busytex (WASM)",
};
```

to:

```ts
const ENGINE_LABEL: Record<string, string> = {
  "system-tex": "pdflatex",
  tectonic: "Tectonic (xelatex)",
  "texlive-wasm": "TeX Live (WASM)",
};
```

- [ ] **Step 2: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -i "EditorSidebar" | head -5
```

Expected: no errors.

---

### Task 8: Tauri resource config

**Files:**
- Modify: `src-tauri/tauri.conf.json:34`

- [ ] **Step 1: Add texlive-wasm resources**

At line 34, change:

```json
"resources": ["resources/templates/**/*"],
```

to:

```json
"resources": ["resources/templates/**/*", "resources/texlive-wasm/**/*"],
```

The `resources/texlive-wasm/` directory is populated by `npx texlive-wasm download-assets ./src-tauri/resources/texlive-wasm` before a mobile build. It's gitignored (like the tectonic sidecar).

- [ ] **Step 2: Add the gitignore entry**

Append to `.gitignore` (or `src-tauri/.gitignore` if one exists):

```
src-tauri/resources/texlive-wasm/
```

---

### Task 9: Delete old busytex provider

**Files:**
- Remove: `src/providers/compile/busytex-provider.ts`

- [ ] **Step 1: Delete the file**

```bash
rm src/providers/compile/busytex-provider.ts
```

- [ ] **Step 2: Verify no remaining imports**

```bash
grep -rn "busytex-provider\|busytex_provider\|compileWithBusytex" src/ --include="*.ts" --include="*.tsx"
```

Expected: zero results (the LatexAdapter import was already updated in Task 5).

- [ ] **Step 3: Grep for any remaining "busytex" references in source**

```bash
grep -rn "busytex" src/ --include="*.ts" --include="*.tsx" | grep -v "node_modules"
```

Expected: zero results. If any remain, update them.

---

### Task 10: SyncTeX branching stub

**Files:**
- Modify: `src/commands/actions.ts:133-157` (syncForwardFromCursor)
- Modify: `src/commands/actions.ts:165-188` (syncInverseFromPdfClick)

- [ ] **Step 1: Add imports**

At the top of `actions.ts`, add:

```ts
import { compileEngine } from "~/stores/settings-store";
```

(Check if it's already imported — it may be via the adapter. If not present, add it.)

- [ ] **Step 2: Update syncForwardFromCursor**

Replace the body of `syncForwardFromCursor` (lines 133-157) with:

```ts
export async function syncForwardFromCursor(): Promise<void> {
  const p = project();
  if (!p) return;
  const file = activeFile();
  if (!file) return;
  const result = lastResult();
  if (!result?.outputPath) return;
  const line = currentCursorLine();
  if (!line) return;

  if (compileEngine() === "texlive-wasm") {
    // JS SyncTeX parser path — wired when texlive-wasm hardening ships
    // the complete parser. Until then, graceful no-op on mobile.
    return;
  }

  try {
    const loc = await ipc.synctexForward({
      projectRoot: p.rootPath,
      pdfPath: result.outputPath,
      sourceFile: file.relPath,
      line,
    });
    if (loc) {
      requestPdfScroll(loc.page, loc.y);
    }
  } catch (e) {
    recordError("synctex-forward", "synctex_forward IPC threw", e);
  }
}
```

- [ ] **Step 3: Update syncInverseFromPdfClick**

Replace the body of `syncInverseFromPdfClick` (lines 165-188) with:

```ts
export async function syncInverseFromPdfClick(
  pageNum: number,
  x: number,
  y: number,
): Promise<void> {
  const p = project();
  if (!p) return;
  const result = lastResult();
  if (!result?.outputPath) return;

  if (compileEngine() === "texlive-wasm") {
    // JS SyncTeX parser path — wired when texlive-wasm hardening ships
    // the complete parser. Until then, graceful no-op on mobile.
    return;
  }

  try {
    const loc = await ipc.synctexInverse({
      pdfPath: result.outputPath,
      page: pageNum,
      x,
      y,
    });
    if (!loc) return;
    const relPath = pathRelativeToProjectRoot(p.rootPath, loc.file);
    if (relPath) requestGotoSource(relPath, loc.line);
  } catch (e) {
    recordError("synctex-inverse", "synctex_inverse IPC threw", e);
  }
}
```

- [ ] **Step 4: Verify**

```bash
npx tsc --noEmit 2>&1 | grep -i "actions" | head -5
```

Expected: no errors.

---

### Task 11: Integration verification

**Files:** None new — verification only.

- [ ] **Step 1: Full type check**

```bash
npx tsc --noEmit
```

Expected: zero errors.

- [ ] **Step 2: Full test suite**

```bash
npm test -- --run
```

Expected: all tests pass (no test touches the compile provider directly — it's all IPC-gated).

- [ ] **Step 3: Grep for any remaining "busytex" references**

```bash
grep -rn "busytex" src/ src-tauri/src/ --include="*.ts" --include="*.tsx" --include="*.rs" | grep -v node_modules
```

Expected: zero results. Any hits need updating.

- [ ] **Step 4: Verify no texlyre-busytex in dependencies**

```bash
grep "texlyre" package.json package-lock.json
```

Expected: zero results.

---

### Task 12: Doc updates

**Files:**
- Modify: `CLAUDE.md`
- Modify: `AGENTS.md`

- [ ] **Step 1: Update CLAUDE.md**

Search-and-replace all `busytex` references:
- `CompileEngine` type description: `"busytex"` → `"texlive-wasm"`
- Architecture seams → busytex CompileProvider section: rename to "texlive-wasm CompileProvider", update the description to reference `texlive-wasm` and `latexmk()` instead of `texlyre-busytex` and `BusyTexRunner`
- Stack anchors section: replace `texlyre-busytex` with `texlive-wasm (file:../texlive-wasm)`
- Commands section: remove the `npx texlyre-busytex download-assets` command, add `npx texlive-wasm download-assets ./src-tauri/resources/texlive-wasm` for mobile builds
- Gotchas: remove the busytex HEAD-probe gotcha, update any remaining busytex references
- Phase 3 description: update to reference texlive-wasm instead of texlyre-busytex

- [ ] **Step 2: Mirror changes to AGENTS.md**

AGENTS.md body is byte-identical to CLAUDE.md per project convention. Copy the updated CLAUDE.md content to AGENTS.md.

- [ ] **Step 3: Verify no remaining busytex in docs**

```bash
grep -n "busytex\|texlyre" CLAUDE.md AGENTS.md
```

Expected: zero results.
