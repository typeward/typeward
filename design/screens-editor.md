# Editor screen — Redesign spec

## Top bar

- **Remove** three traffic-light dots.
- **Project switcher** (`τ` icon + name): on click, opens a recent-projects
  dropdown. Selecting one opens that project. A "Back to all projects" item at
  the bottom routes to the Projects screen (replaces current behavior where
  the switcher itself navigates).
- **Remove** the local user's avatar from the right cluster. Only show
  collaborators when collab is live. Today: empty avatar stack.
- **Bigger icons** for share / history / layout / settings (24px target).
- **Settings round-trip**: leaving Settings via a back button or `Esc` returns
  to the editor project, not the Projects screen. Implementation: stash
  `lastRoute` in the route store when navigating away.

## Layout menu

The layout icon opens a small panel with two sections:

### Section 1 — Pane layout

| Option | Effect |
|---|---|
| **Split view** (default) | Files / Editor / Preview, current 3-pane |
| **Editor only** | Hide preview pane, expand editor |
| **PDF only** | Hide editor pane, expand preview |

### Section 2 — Console position

| Option | Effect |
|---|---|
| **Bottom drawer** (default) | Console panel docks at the bottom (current behavior) |
| **In PDF panel** | Console becomes a tabbed view inside the preview panel — a console icon between Export and AI buttons in the PDF toolbar swaps the panel content between PDF and Console |

When Console is "in PDF panel", the bottom drawer disappears entirely.

## Center (editor) pane

- **Remove** the "Save" and "Compile" buttons in the tab strip's top-right
  corner. The original design has these handled by:
  - keyboard shortcuts (`Mod+S`, `Mod+Enter`) — already wired
  - the floating format panel (below) for ad-hoc save
  - the PDF panel's Recompile button for compile
- **Floating format panel**: matches `design_files/editors/editor-variants.jsx`
  — a small floating toolbar near the cursor with Bold / Italic / Math /
  Section / List / Cite. Today it's missing; this restores it.
- **Status bar**: minimal. Drop the line-count display (already shown in the
  left files panel) and switch to `Ln 12, Col 4` format, matching the design.
- **Scrollbar**: custom-styled to match the glass aesthetic. Thin (8px),
  semi-transparent thumb that lightens on hover.

## Left panel

- **Max width** capped (proposed: 320px). Prevents accidental over-pull.
- **Bottom row reshuffle**: action icons (new folder, new file, more menu) move
  to the right side of the "FILES" header row, opposite the section label.
- **"Format" → "Engine"** label at the bottom. Shows the current LaTeX engine
  (e.g. "pdflatex", "xelatex", "lualatex") when project format is LaTeX.
  Hidden for non-LaTeX projects.

## Right (PDF) pane

### Toolbar restructure

```
[Recompile ⌘↵]  [Console] [AI] [Export ▾]   [zoom ▾]  [< 1/N >]
^ leftmost group ─────────────────────────^ ^ rightmost group ─^
```

- **Recompile**: same as today; keyboard hint platform-specific.
- **Console** (only shown when layout has Console-in-PDF-panel): toggles panel
  content between PDF render and console (logs/issues tabs).
- **AI**: toggles panel content between PDF render and AI assistant view.
- **Export** (replaces the download icon): dropdown:
  - Export PDF
  - Export PDF with annotations
  - Export Markdown
  - Export DOCX
  - Export HTML (LaTeX/Typst → pandoc)
  - Export source (zip)
- **Zoom**: moved to the right. Click opens a vertical menu:
  - **Custom (10–100)**: numeric input
  - **Slider** (10–400%)
  - **Fit width** (default)
  - **Fit height**
  - **Presets**: 50, 75, 100, 150, 200
- **Page nav**: page indicator + prev/next on the far right.

### PDF panel sizing

The preview panel's resize handle constrains panel width directly; **PDF
content scales independently** within. Right now if the user zooms past panel
width the panel doesn't grow; we preserve that, but also: changing the PDF's
intrinsic size (page width) doesn't reflow the panel. Fix the existing bug
where loading a wide-page PDF can balloon the panel.

### SyncTeX interactions

Add to existing forward/inverse (shift+click → inverse):

- **Double-click PDF text → editor jumps** to that location. Same as shift+click
  today but with a more discoverable gesture.
- **Selection in PDF mirrors in editor** when possible: select text in the PDF
  → corresponding source range highlighted in the editor. Needs PDF.js text
  layer + per-glyph synctex coords. Stretch goal — flag as deferred if too
  heavy for this slice.

### AI panel (stub)

When AI is toggled on, the right panel renders an AI chat shell:

```
┌─────────────────────────────────┐
│ AI Assistant            [×]     │
├─────────────────────────────────┤
│                                 │
│   👋 Hi — AI chat is coming     │
│   soon. The view is wired so    │
│   it's ready when we plug in    │
│   a model.                      │
│                                 │
├─────────────────────────────────┤
│ [Type a message...]      [Send] │
└─────────────────────────────────┘
```

The Send button + textarea exist but are disabled. Settings has a
forward-looking section noting an AI provider config will surface here.

## Bottom drawer (Logs)

- Tabs today: Logs, Issues, Bibliography, Chat.
- **Remove** Bibliography and Chat tabs. Both belong elsewhere or are out of
  scope.
- Final tabs: Logs, Issues.

## Removed elements summary

| Element | Why / replaced by |
|---|---|
| Three traffic-light dots | Tauri owns chrome |
| Local user avatar | Only collaborators belong here |
| Save / Compile buttons in tab strip | Shortcuts + Recompile cover it |
| Bibliography drawer tab | Out of scope |
| Chat drawer tab | Replaced by AI panel toggle |
| Download icon | Replaced by Export dropdown |

## New settings surfaced

| Setting | Default | Section |
|---|---|---|
| Pane layout default | "split" | Editor |
| Console position | "drawer" | Editor |
| Zoom default | "fit-width" | Editor |
| Last-route-before-settings memory | (internal) | — |
