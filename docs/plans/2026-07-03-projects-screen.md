# Projects screen — completion plan (2026-07-03, approved)

Scope decision (user-approved): **full set** — real Spaces + Tags with persistence and filtering, library search, star/favorite, archive, card context menu, rename/delete/duplicate project.

Current state: `src/screens/projects/ProjectsScreen.tsx` ships hardcoded sample Spaces/Tags behind `enableSpaces`/`enableTags` with dead sidebar nav; no filter chips or search (TopBar search opens the palette); cards have no star/overflow; the `last-opened` sort is a no-op; no rename/delete/duplicate IPCs exist. The data model (TS `Project` in `src/adapters/types.ts`, Rust in `src-tauri/src/project.rs`) has no tags/space/starred/archived/lastOpenedAt fields. Known defaults mismatch: Rust `WorkspaceSettings::default()` enables spaces/tags, the frontend store defaults them off — fresh installs show sample data.

## 1. Data model

Per-project state lives in `.typeward/project.json` (additive `#[serde(default)]`, no schema bump; `.typeward` is already excluded from git and cloud sync):

```rust
#[serde(default, skip_serializing_if = "Vec::is_empty")]      pub tags: Vec<String>,
#[serde(default, skip_serializing_if = "Option::is_none")]    pub space: Option<String>,      // space id
#[serde(default, skip_serializing_if = "std::ops::Not::not")] pub starred: bool,
#[serde(default, skip_serializing_if = "std::ops::Not::not")] pub archived: bool,
#[serde(default, skip_serializing_if = "Option::is_none")]    pub last_opened_at: Option<i64>, // epoch ms
```

TS mirror: `tags?: string[]`, `space?: string`, `starred?: boolean`, `archived?: boolean`, `lastOpenedAt?: number`. Update every Rust `Project {}` literal (create/import/tests).

**Spaces catalog** is workspace-level: `workspace.spaces: Vec<SpaceDef { id, name, tint }>` in settings.json (order = array order), mirrored in `ipc.WorkspaceSettings`, a `spaces`/`setSpaces` signal in `workspace-store.ts`, and one `field()` entry in `settings-store.ts` FIELDS with malformed-entry filtering. `tint` is a named palette id (`accent|violet|teal|amber|rose|green|slate`) mapped to CSS vars so themes re-tint. Ids from `crypto.randomUUID()`.

**Tags are derived-from-use, no catalog**: the sidebar tag list is a memo over `projects()` (union of tags on non-archived projects, count-then-name sorted); tag color = stable hash of the tag string into the tint palette. Zero persistence, no orphan management.

## 2. New IPC surface (8 commands)

All commands: `pub async fn` + `tokio::task::spawn_blocking` + `ensure_registered` + `.map_err(|e| e.to_string())`, registered in `lib.rs generate_handler![]`, typed wrapper in `src/ipc/index.ts` (the drift test auto-covers them). Template: `set_project_deadline` (commands.rs) + `project.rs::set_deadline` read-modify-write.

| Command | Signature | Validation / behavior |
|---|---|---|
| `set_project_tags` | `(root, tags: Vec<String>) -> Project` | max 32 tags; each trimmed 1..=48 chars, no control chars; case-insensitive dedupe preserving first casing |
| `set_project_space` | `(root, space: Option<String>) -> Project` | Some ⇒ non-empty ≤64 chars; no catalog cross-check (frontend renders unknown ids as unassigned) |
| `set_project_starred` | `(root, starred: bool) -> Project` | — |
| `set_project_archived` | `(root, archived: bool) -> Project` | — |
| `touch_project_opened` | `(root) -> ()` | stamps now(); fire-and-forget from the frontend |
| `rename_project` | `(root, name: String) -> Project` | trimmed 1..=128, no control chars. **Display-name only** — folder rename is deferred (root-registry re-registration, live watcher, `/editor?path=` URLs, cloud cache binding, git path, Windows file locks; no visible gain since the folder name only shows in the import picker) |
| `delete_project` | `(root) -> ()` | **OS trash** via new `trash = "5"` crate dep (`trash::delete` in spawn_blocking). Recoverable ⇒ plain danger-confirm Dialog, no typed-name confirmation. Confirm copy adds a line when `integrations.cloudOrigin` is set (remote copy stays). No registry unregister needed — `is_registered_root` canonicalizes, and a trashed folder falls out naturally |
| `duplicate_project` | `(root, new_name: Option<String>) -> Project` | dest `projectsRoot/<sanitized>` with `-2/-3` collision suffix + `ensure_under_projects_root`; copy walk mirrors `TEMPLATE_SKIP_DIRS` (`.typeward`/`.git`/`.svn`/`.hg`/`node_modules`, skip symlinks); copies `.typeward/citations/` verbatim (user data + instant `\cite` completions); fresh project.json keeps rootFile/format/deadline/tags/space, clears starred/archived/lastOpenedAt, keeps `integrations.references`, **drops cloudOrigin + git** (two projects pushing one remote = conflicts; the copy has no `.git`); `register_root(dest)` |

Frontend `projects-store.ts`: `setTags/setSpace/setStarred/setArchived/rename/remove/duplicate` copying the `setDeadline` optimistic-patch pattern; errors via `describeIpcError` → toast.

## 3. Filtering + search

```ts
type LibrarySelection =
  | { kind: "all" } | { kind: "starred" } | { kind: "archive" }
  | { kind: "space"; id: string } | { kind: "tag"; tag: string };
```

Session-scoped `selection` + `search` signals (reset on revisit — matches palette/focus-mode precedent). One memo pipeline replacing `sortedProjects`:
1. Archive split — archive view shows only archived; every other view excludes archived.
2. Selection filter — starred / space id / tag membership.
3. Search — case-insensitive substring over name, rootFile, tags.
4. Existing sort switch, with `last-opened` fixed (below).

- Search input lives in the library Toolbar (glass-inset, Search icon, Escape/X clears with stopPropagation so the dismiss layer doesn't eat Escape). TopBar search keeps opening the palette. Zero-result state renders a "Clear filters" action.
- Sidebar: Library = All / Starred / Archive (always visible, with counts). Spaces render from the catalog with per-space counts, a `+` add popover (name input + tint swatches) on the group header, and a per-space mini-menu (Rename / Change color / Delete — delete removes the catalog entry only; projects holding a stale id render as unassigned). Tags render from the derived union. `SidebarItem` gains `onSelect`; drop the "· sample" header suffixes.
- **Fix the defaults mismatch**: flip the frontend `workspace-store` `enableSpaces`/`enableTags` defaults to `true` (the features are real now); update the Settings → Workspace hint copy.

## 4. Card/row chrome + context menu

- Card header becomes `[format badge] ── [★] [DeadlineEditor] [⋯]` (star hover-revealed unless starred, stopPropagation). Row variant: star before the name, `⋯` at the end. Archived items render dimmed with an "Archived" chip. Up to 3 non-interactive tag chips with `+n` overflow (click still opens the project).
- New `src/components/projects/ProjectMenu.tsx` — hand-rolled fixed-position menu (no primitive exists; App.tsx suppresses native context menus): opened from card `onContextMenu` (cursor coords, viewport-clamped) or the `⋯` button; `installDismiss` + close-on-scroll; `listbox-nav` keyboard handling. Items: Open, Star/Unstar, Move to space (nested column, not a true submenu), Edit tags…, Rename…, Duplicate, Archive/Unarchive, separator, Delete… (err tone). Rename/Duplicate share a small name Dialog; Delete uses the danger-confirm Dialog (`Button variant="danger"`).
- Tag editor popover: current tags as removable chips + Enter-commit input + suggestion list from the known-tag union; one `setTags` per change (optimistic).
- While touching everything, extract Sidebar/Toolbar/ProjectMenu into `src/components/projects/`.

## 5. last-opened sort fix

`EditorScreen` open effect: after a successful `ipc.openProject`, fire-and-forget `touchProjectOpened(rootPath)` — a single chokepoint covering every entry path since all opens route through `/editor?path=`. Sort: `lastOpenedAt` desc, missing values sink, tie-break by name; relabel `SORT_LABEL["last-opened"]` to "Last opened".

Notifications panel stays as-is (real delivery is an explicitly deferred feature).

## Edge cases

- Legacy project.json files: all new fields default cleanly; add Rust round-trip tests mirroring `deadline_round_trips_and_clears` plus a legacy-file load test.
- Tag strings with `,`/unicode are fine; validation only rejects control chars and length.
- Trash failures on odd Linux setups surface verbatim in the confirm dialog (acceptable v1).
- Duplicate optionally also skips LaTeX build junk using `template_save`'s extension skip list.

## Verification

`cargo test --manifest-path src-tauri/Cargo.toml` (new project.rs tests), `npm test` (drift test picks up the 8 commands), `npm run typecheck`. Manual: star/tag/space/archive a project → `.typeward/project.json` reflects it and survives restart; sidebar filters compose with search + sort; delete → Recycle Bin; duplicate → copy minus `.git`/`.typeward` except citations; open a project → reorders under "Last opened"; fresh profile shows real (empty) Spaces/Tags sections, no sample data.

## Sequencing

1. Rust foundation: project.rs fields + setters + tests; 8 commands; lib.rs registration; `trash` dep.
2. Spaces catalog plumbing (settings.rs / ipc.ts / workspace-store / settings-store FIELDS).
3. projects-store actions + ipc wrappers (drift test green).
4. ProjectsScreen UI (selection/search pipeline, sidebar wiring + space management, star, ProjectMenu + dialogs, tag popover, defaults-mismatch fix + Settings hint copy).
5. lastOpenedAt stamp + sort fix.

Related docs: `2026-07-03-editor.md`, `2026-07-03-settings.md` (this repo, same batch).
