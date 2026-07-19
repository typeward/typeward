import {
  AtSign,
  Bold,
  Code2,
  Heading1,
  Image as ImageIcon,
  Italic,
  Link as LinkIcon,
  List,
  ListOrdered,
  Pi,
  Quote,
  Sigma,
  Table2,
  Underline,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show } from "solid-js";
import {
  activeFormattingLanguage,
  applyFormat,
  supportsFormat,
  type FormatKind,
  type FormattingLanguage,
} from "~/commands/format-actions";
import { isVisualEligibleFile } from "~/adapters/languages";
import { IconButton } from "~/components/primitives/IconButton";
import { activeFile } from "~/stores/editor-store";
import { editorSettings, setEditorSettings } from "~/stores/settings-store";
import { VISUAL_PAUSED_TOOLTIP, visualPaused } from "~/stores/visual-store";
import { touchAffordances } from "~/stores/viewport-store";

interface ToolBtn {
  kind: FormatKind;
  label: string;
  /** Advertised in the tooltip only — the binding lives in boot.ts. */
  shortcut?: string;
  icon: (size: number) => JSX.Element;
}

const STYLE_GROUP: ToolBtn[] = [
  { kind: "bold", label: "Bold", shortcut: "Mod+B", icon: (s) => <Bold size={s} /> },
  { kind: "italic", label: "Italic", shortcut: "Mod+I", icon: (s) => <Italic size={s} /> },
  {
    kind: "underline",
    label: "Underline",
    shortcut: "Mod+U",
    icon: (s) => <Underline size={s} />,
  },
  { kind: "code", label: "Inline code", icon: (s) => <Code2 size={s} /> },
];

const STRUCTURE_GROUP: ToolBtn[] = [
  { kind: "heading", label: "Heading", icon: (s) => <Heading1 size={s} /> },
  { kind: "list", label: "Bulleted list", icon: (s) => <List size={s} /> },
  {
    kind: "orderedList",
    label: "Numbered list",
    icon: (s) => <ListOrdered size={s} />,
  },
  { kind: "quote", label: "Block quote", icon: (s) => <Quote size={s} /> },
];

const INSERT_GROUP: ToolBtn[] = [
  { kind: "inlineMath", label: "Inline math", icon: (s) => <Pi size={s} /> },
  { kind: "equation", label: "Equation", icon: (s) => <Sigma size={s} /> },
  { kind: "figure", label: "Figure", icon: (s) => <ImageIcon size={s} /> },
  { kind: "table", label: "Table", icon: (s) => <Table2 size={s} /> },
  { kind: "link", label: "Link", icon: (s) => <LinkIcon size={s} /> },
  { kind: "citation", label: "Citation", icon: (s) => <AtSign size={s} /> },
];

/**
 * Format toolbar mounted below the file-tabs strip in the editor pane.
 * Three groups separated by vertical dividers: text style, document
 * structure, insert. Buttons run the shared format actions (selection wrap
 * / list conversion / caret insert — see commands/format-actions.ts).
 *
 * The whole bar renders only when the active file takes prose formatting
 * (.tex/.typ/.md — not .bib, not images), and each group hides the buttons
 * the file's dialect lacks (underline on markdown). Every dialect keeps at
 * least one button per group today, so the dividers stay unconditional.
 */
export const FormatToolbar: Component = () => {
  return (
    <Show when={activeFormattingLanguage()}>
      {(lang) => (
        <div
          class="flex flex-shrink-0 items-center gap-0.5 overflow-x-auto border-b border-glass-stroke px-2 scroll"
          classList={{ "h-12": touchAffordances(), "h-9": !touchAffordances() }}
        >
          <ToolGroup buttons={STYLE_GROUP} lang={lang()} />
          <Divider />
          <ToolGroup buttons={STRUCTURE_GROUP} lang={lang()} />
          <Divider />
          {/* Only true insertions get the "Insert" prefix — style/structure
              actions wrap or convert the selection, so their bare names are the
              accurate tooltip copy. */}
          <ToolGroup buttons={INSERT_GROUP} lang={lang()} labelPrefix="Insert " />
          <VisualModeToggle />
        </div>
      )}
    </Show>
  );
};

/**
 * Source | Visual segmented control, right-aligned; shown only for
 * visual-eligible files (.tex). The control IS the persisted setting
 * (`editor.visualModeLatex`, synced with the rest of the editor block); a
 * visual-paused file falls back to Source with the paused tooltip and a
 * disabled Visual segment — the setting itself is untouched, so other files
 * stay visual.
 */
const VisualModeToggle: Component = () => {
  const relPath = () => activeFile()?.relPath ?? null;
  const eligible = () => {
    const p = relPath();
    return p !== null && isVisualEligibleFile(p);
  };
  const paused = () => {
    const p = relPath();
    return p !== null && visualPaused(p);
  };
  const visualOn = () => editorSettings().visualModeLatex && !paused();
  const setMode = (visual: boolean) =>
    setEditorSettings({ ...editorSettings(), visualModeLatex: visual });

  const segClass = (active: boolean) =>
    `lift flex flex-shrink-0 items-center rounded px-2 text-xs font-medium disabled:cursor-not-allowed disabled:opacity-50 ${
      touchAffordances() ? "h-9" : "h-5"
    } ${active ? "text-fg-1" : "text-fg-3 hover:text-fg-2"}`;
  const segStyle = (active: boolean) =>
    active
      ? {
          background: "var(--color-control-fill-hover)",
          border: "1px solid var(--color-control-stroke)",
        }
      : undefined;

  return (
    <Show when={eligible()}>
      <div
        class={`ml-auto flex flex-shrink-0 items-center gap-0.5 rounded-md p-0.5 ${
          touchAffordances() ? "h-11" : ""
        }`}
        style={{ background: "var(--color-control-fill)" }}
        role="group"
        aria-label="Editing mode"
        title={paused() ? VISUAL_PAUSED_TOOLTIP : undefined}
      >
        <button
          type="button"
          aria-pressed={!visualOn()}
          onClick={() => setMode(false)}
          class={segClass(!visualOn())}
          style={segStyle(!visualOn())}
        >
          Source
        </button>
        <button
          type="button"
          aria-pressed={visualOn()}
          disabled={paused()}
          title={
            paused()
              ? VISUAL_PAUSED_TOOLTIP
              : "Edit as a formatted document (Mod+Shift+V)"
          }
          onClick={() => setMode(true)}
          class={segClass(visualOn())}
          style={segStyle(visualOn())}
        >
          Visual
        </button>
      </div>
    </Show>
  );
};

const ToolGroup: Component<{
  buttons: ToolBtn[];
  lang: FormattingLanguage;
  labelPrefix?: string;
}> = (props) => (
  <For each={props.buttons.filter((b) => supportsFormat(props.lang, b.kind))}>
    {(b) => (
      // touchTarget: this toolbar is the surface the 44px touch bump was
      // designed for (the container grows to h-12 alongside it).
      <IconButton
        label={`${props.labelPrefix ?? ""}${b.label}`}
        shortcut={b.shortcut}
        size="md"
        touchTarget
        onClick={() => applyFormat(b.kind)}
      >
        {b.icon(touchAffordances() ? 16 : 13)}
      </IconButton>
    )}
  </For>
);

const Divider: Component = () => (
  <div class="mx-1 h-4 w-px flex-shrink-0" style={{ background: "var(--color-control-stroke)" }} />
);
