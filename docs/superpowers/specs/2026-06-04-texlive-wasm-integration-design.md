# Typeward texlive-wasm Integration — Design Spec

Replace `texlyre-busytex` with Typeward's own `texlive-wasm` as the LaTeX compile engine on Android/iOS. The WASM engine is the sole compile option on mobile (not user-selectable), ships fully bundled in the APK/IPA for offline-from-install operation, and uses the `latexmk()` high-level API for multi-pass compilation.

## 1. Dependency Swap

Remove `texlyre-busytex` from `package.json`. Add `texlive-wasm` as a local dependency:

```json
"texlive-wasm": "file:../texlive-wasm"
```

Switch to a versioned npm dependency when texlive-wasm publishes. The `texlive-wasm/tauri` subpath export provides `TauriFS` for native filesystem access to bundled assets.

## 2. CompileEngine Type + Platform Gating

### Type change

```ts
// src/stores/settings-store.ts
export type CompileEngine = "system-tex" | "tectonic" | "texlive-wasm";
```

### Platform behavior

**Mobile (Android/iOS):**
- Engine force-set to `"texlive-wasm"` at startup. Not user-changeable.
- Settings → Editor → Compilation engine picker is hidden.
- Persisted `"busytex"` migrates to `"texlive-wasm"` on load.

**Desktop (Win/Mac/Linux):**
- Engine picker shows only `"system-tex"` and `"tectonic"` (unchanged).
- `"texlive-wasm"` is not available — desktop has real TeX on PATH.
- Persisted `"busytex"` migrates to `"system-tex"` on load.

### Migration logic

In the settings load path (`src/stores/settings-store.ts`), when parsing the persisted `compileEngine` value:

```ts
function migrateCompileEngine(raw: string): CompileEngine {
  if (raw === "busytex") {
    return isMobilePlatform() ? "texlive-wasm" : "system-tex";
  }
  if (raw === "texlive-wasm" && !isMobilePlatform()) {
    return "system-tex";
  }
  return raw as CompileEngine;
}
```

`isMobilePlatform()` uses Tauri's `platform()` from `@tauri-apps/plugin-os` (or the existing `isTabletViewport()` if sufficient — but OS detection is more reliable than viewport width for this purpose).

### Platform default

```ts
const defaultEngine: CompileEngine = isMobilePlatform() ? "texlive-wasm" : "system-tex";
```

## 3. Compile Provider

### New file: `src/providers/compile/texlive-wasm-provider.ts`

Replaces `busytex-provider.ts`. Uses the `latexmk()` high-level API from `texlive-wasm`.

**Lazy initialization:**

```ts
import { latexmk, type LatexmkResult, type FileInput } from "texlive-wasm";
import { withTauriFs } from "texlive-wasm/tauri";
import { BaseDirectory } from "@tauri-apps/plugin-fs";

let engineConfigPromise: Promise<EngineConfig> | null = null;

function getEngineConfig(): Promise<EngineConfig> {
  if (engineConfigPromise) return engineConfigPromise;
  engineConfigPromise = (async () => {
    const vfs = await withTauriFs({
      texmfRoot: "texlive-wasm/texmf",
      baseDir: BaseDirectory.Resource,
    });
    return { vfs };
  })();
  return engineConfigPromise;
}
```

**Compile flow:**

```ts
export async function compileWithTexliveWasm(project: Project): Promise<CompileResult> {
  const started = performance.now();

  // 1. Read root file
  const input = await ipc.readProjectTextFile(project.rootPath, project.rootFile);

  // 2. Collect sibling files (reused from old provider)
  const siblings = await collectProjectFiles(project.rootPath, project.rootFile);

  // 3. Build FileInput array
  const files: FileInput[] = [
    { path: project.rootFile, content: input },
    ...siblings.map(f => ({ path: f.path, content: f.content })),
  ];

  // 4. Call latexmk
  const config = await getEngineConfig();
  const result = await latexmk({
    engine: "pdflatex",
    mainTex: project.rootFile,
    files,
    bibtex: "auto",
    makeindex: "auto",
    rerun: "auto",
    ...config,
  });

  // 5. Write PDF
  let outputPath: string | undefined;
  if (result.success && result.pdf) {
    const buildRelDir = ".typeward/build";
    const pdfRel = `${buildRelDir}/${replaceExt(project.rootFile, "pdf")}`;
    outputPath = `${project.rootPath}/${pdfRel}`;
    await ipc.writeProjectBinaryFile(project.rootPath, pdfRel, result.pdf);
  }

  // 6. Persist SyncTeX blob
  if (result.synctex && result.synctex.byteLength > 0) {
    const isGzipped = result.synctex[0] === 0x1f && result.synctex[1] === 0x8b;
    const ext = isGzipped ? "synctex.gz" : "synctex";
    const synctexRel = `.typeward/build/${replaceExt(project.rootFile, ext)}`;
    try {
      await ipc.writeProjectBinaryFile(project.rootPath, synctexRel, result.synctex);
    } catch { /* soft fail */ }
  }

  // 7. Parse diagnostics via Rust log parser
  let diagnostics: CompileResult["diagnostics"] = [];
  try {
    const parsed = await ipc.parseLatexLog(result.log, project.rootFile);
    diagnostics = parsed.map(d => ({
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

### File walking

The `collectProjectFiles()` function from the current `busytex-provider.ts` is preserved in the new file. It's solid code — same skip-dirs, same text/binary extension sets, same 200-file/10MB cap. Only the import path changes since it moves to the new provider.

## 4. Asset Bundling (Mobile Builds)

### Build-time

The texlive-wasm assets are placed in `src-tauri/resources/texlive-wasm/` during the mobile build setup:

```bash
npx texlive-wasm download-assets ./src-tauri/resources/texlive-wasm
```

This downloads and unpacks:
- `pdflatex/emscripten/pdflatex.wasm` (~1.3 MB)
- `pdflatex/emscripten/pdflatex.js` (~37 KB)
- `pdflatex.fmt` (format file, ~10 MB)
- `texmf/` (full TeX Live TDS, ~355 MB uncompressed; ~120 MB compressed in APK)
- `icudt78l.dat` (~21 MB, for future xelatex/bibtexu support)

The directory is gitignored (like the tectonic sidecar binary).

### tauri.conf.json

Add the texlive-wasm resources to the bundle config:

```json
{
  "bundle": {
    "resources": [
      "resources/templates/**/*",
      "resources/texlive-wasm/**/*"
    ]
  }
}
```

### Runtime

`TauriFS` from `texlive-wasm/tauri` reads the files via `@tauri-apps/plugin-fs` with `BaseDirectory.Resource`. No fetch calls, no CDN, no OPFS. Everything is on-device from install.

## 5. Adapter / Action Routing

### LatexAdapter compile dispatch

In `src/adapters/latex/LatexAdapter.ts` (or wherever `compile()` dispatches based on engine), add the `"texlive-wasm"` case:

```ts
case "texlive-wasm": {
  const { compileWithTexliveWasm } = await import(
    "~/providers/compile/texlive-wasm-provider"
  );
  return compileWithTexliveWasm(project);
}
```

Dynamic import keeps the WASM bridge out of the desktop bundle (same pattern as the current busytex dynamic import).

### SyncTeX branching

In `src/commands/actions.ts` (or the synctex dispatch path):

**Mobile (texlive-wasm engine):**
- After compilation, if the result includes a `.synctex.gz` blob, parse it via `createSynctex()` from `texlive-wasm`.
- Forward search: `synctex.forward(file, line)` → `requestPdfScroll(page, y)`.
- Inverse search: `synctex.reverse(page, x, y)` → `requestGotoSource(relPath, line)`.
- The JS parser runs in-process (no CLI shell-out needed).

**Desktop (system-tex / tectonic):**
- No change. The existing `synctex` CLI shell-out in `src-tauri/src/synctex.rs` continues unchanged.

**Fallback:** Until the texlive-wasm hardening spec ships the complete SyncTeX parser, mobile SyncTeX is a graceful no-op. The provider still persists the `.synctex.gz` blob so the CLI path works if the user has the synctex binary on PATH (unlikely on mobile but harmless).

The branching point reads `compileEngine()`:

```ts
if (compileEngine() === "texlive-wasm") {
  // JS SyncTeX parser path
} else {
  // Rust CLI shell-out path (existing)
}
```

## 6. Settings UI Changes

### Engine picker visibility

In `src/screens/settings/SettingsScreen.tsx`, the Compilation engine picker section:

```tsx
<Show when={!isMobilePlatform()}>
  {/* Engine picker: system-tex / tectonic */}
</Show>
```

On mobile, the picker is hidden entirely. The engine label in the sidebar footer (`EditorSidebar.tsx` `ENGINE_LABEL` map) adds:

```ts
"texlive-wasm": "TeX Live (WASM)",
```

### Remove busytex install-status probe

The current Settings → Editor → Compilation section has a busytex asset install-status badge that HEAD-probes `/core/busytex/busytex_pipeline.js` and shows the `npx texlyre-busytex download-assets` command when missing. This entire section is removed — texlive-wasm assets are bundled, not user-installed.

## 7. Cleanup

### Remove

| What | Where |
|---|---|
| `texlyre-busytex` dependency | `package.json` |
| `busytex-provider.ts` | `src/providers/compile/` |
| `ensureAssetsInstalled()` fetch probe | was in busytex-provider |
| busytex install-status badge + instructions | Settings → Editor → Compilation |
| `"busytex"` references in CLAUDE.md | Architecture seams, gotchas, stack sections |
| `"busytex"` references in plan.md | Phase 3 section |
| `public/core/busytex/` asset instructions | CLAUDE.md commands section |

### Keep (moved to new provider)

| What | Why |
|---|---|
| `collectProjectFiles()` file walker | Solid code, same logic needed |
| SyncTeX blob persistence (gzip-sniff) | Same pattern, same disk path |
| Rust `parse_latex_log_cmd` IPC | Diagnostic parsing unchanged |
| `replaceExt()` helper | Still needed for PDF/SyncTeX paths |

### Update

| What | Change |
|---|---|
| `CompileEngine` type | `"busytex"` → `"texlive-wasm"` |
| `ENGINE_LABEL` map | Add `"texlive-wasm"` entry, remove `"busytex"` |
| CLAUDE.md | Replace busytex references with texlive-wasm throughout |
| plan.md | Update Phase 3 busytex section |
| AGENTS.md | Mirror CLAUDE.md changes |

## File Structure

```
New:
  src/providers/compile/texlive-wasm-provider.ts  — new compile provider

Modified:
  package.json                            — swap texlyre-busytex → texlive-wasm
  package-lock.json                       — regenerated
  src/stores/settings-store.ts            — CompileEngine type, migration, platform default
  src/adapters/latex/LatexAdapter.ts      — add texlive-wasm compile dispatch
  src/commands/actions.ts                 — SyncTeX branching (JS parser vs CLI)
  src/screens/settings/SettingsScreen.tsx  — hide engine picker on mobile
  src/components/editor/EditorSidebar.tsx  — ENGINE_LABEL entry
  src-tauri/tauri.conf.json               — texlive-wasm resources for mobile
  CLAUDE.md                               — replace busytex references
  AGENTS.md                               — mirror CLAUDE.md
  plan.md                                 — update Phase 3

Removed:
  src/providers/compile/busytex-provider.ts
  texlyre-busytex dependency from package.json
```

## Dependencies

This spec assumes the texlive-wasm hardening spec (separate repo, separate instance) is complete or at least has:
- `latexmk()` API working with auto-dispose (issue #6 fix)
- Timeout enforcement (issue #1 fix)
- Post-crash cleanup (issue #2 fix)

SyncTeX JS parser completion (issue #3) is a soft dependency — the integration works without it (graceful no-op on mobile), and wires in automatically once the parser is done.

## Out of Scope

- xelatex / lualatex engine selection on mobile (pdflatex only until ICU wiring lands in hardening spec)
- Custom TDS package management UI (download individual packages)
- CDN fallback for rare packages on mobile
- OPFS caching (desktop web target, not relevant for Tauri mobile)
- texlive-wasm npm publishing workflow
