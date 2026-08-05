/**
 * Hand-built DOM widgets for the visual mode (v1 MarkerWidget precedent —
 * no framework: CM churns widget instances on eq() misses and none of these
 * are reactive; all interactive UI lives in the single Solid popover
 * overlay, reached through the click handler in cm6.ts).
 */

import { WidgetType } from "@codemirror/view";

const el = (
  tag: string,
  className: string,
  text?: string,
): HTMLElement => {
  const node = document.createElement(tag);
  node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};

/** Generic inline chip: unknown commands, verb, cite/ref pills, ⏎, braces. */
export class ChipWidget extends WidgetType {
  constructor(
    readonly label: string,
    readonly className: string,
    readonly title: string,
    readonly selected: boolean,
  ) {
    super();
  }

  override eq(other: ChipWidget): boolean {
    return (
      other.label === this.label &&
      other.className === this.className &&
      other.title === this.title &&
      other.selected === this.selected
    );
  }

  override toDOM(): HTMLElement {
    const chip = el("span", `cm-vis-chip ${this.className}`, this.label);
    chip.title = this.title;
    if (this.selected) chip.classList.add("cm-vis-chip-selected");
    return chip;
  }

  override ignoreEvent(): boolean {
    // Let mousedown reach the editor's domEventHandlers (widget click →
    // select construct / open popover).
    return false;
  }
}

/** A literal glyph standing in for its escape (`\%` → `%`). */
export class GlyphWidget extends WidgetType {
  constructor(readonly ch: string) {
    super();
  }

  override eq(other: GlyphWidget): boolean {
    return other.ch === this.ch;
  }

  override toDOM(): HTMLElement {
    return el("span", "cm-vis-glyph", this.ch);
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** List item marker: bullet, ordinal, or custom label. */
export class MarkerWidget extends WidgetType {
  constructor(
    readonly text: string,
    readonly depth: number,
  ) {
    super();
  }

  override eq(other: MarkerWidget): boolean {
    return other.text === this.text && other.depth === this.depth;
  }

  override toDOM(): HTMLElement {
    return el("span", "cm-vis-marker", this.text);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/**
 * Ghost placeholder giving the caret a visible home inside an emptied
 * construct (undo can resurrect `\section{}` states the guards would never
 * create going forward).
 */
export class GhostWidget extends WidgetType {
  constructor(readonly label: string) {
    super();
  }

  override eq(other: GhostWidget): boolean {
    return other.label === this.label;
  }

  override toDOM(): HTMLElement {
    return el("span", "cm-vis-ghost", this.label);
  }

  override ignoreEvent(): boolean {
    return true;
  }
}

/** Block card: math/table/figure/unknown-env placeholders (upgraded by later phases). */
export class BlockCardWidget extends WidgetType {
  constructor(
    readonly kind: string,
    readonly label: string,
    readonly preview: string,
    readonly selected: boolean,
  ) {
    super();
  }

  override eq(other: BlockCardWidget): boolean {
    return (
      other.kind === this.kind &&
      other.label === this.label &&
      other.preview === this.preview &&
      other.selected === this.selected
    );
  }

  override toDOM(): HTMLElement {
    const card = el("div", `cm-vis-card cm-vis-card-${this.kind}`);
    if (this.selected) card.classList.add("cm-vis-card-selected");
    card.appendChild(el("span", "cm-vis-card-badge", this.label));
    if (this.preview) {
      card.appendChild(el("span", "cm-vis-card-preview", this.preview));
    }
    return card;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/**
 * `\maketitle`, rendered as the title block it produces. The fields are
 * resolved by the decoration builder from `\title` / `\author` / `\date`
 * wherever they sit in the document — this widget only paints them.
 */
export class TitleWidget extends WidgetType {
  constructor(
    readonly title: string,
    readonly author: string,
    readonly date: string,
    readonly selected: boolean,
  ) {
    super();
  }

  override eq(other: TitleWidget): boolean {
    return (
      other.title === this.title &&
      other.author === this.author &&
      other.date === this.date &&
      other.selected === this.selected
    );
  }

  override toDOM(): HTMLElement {
    const card = el("div", "cm-vis-card cm-vis-title");
    if (this.selected) card.classList.add("cm-vis-card-selected");
    card.appendChild(el("div", "cm-vis-title-main", this.title));
    if (this.author) card.appendChild(el("div", "cm-vis-title-sub", this.author));
    if (this.date) card.appendChild(el("div", "cm-vis-title-sub", this.date));
    card.title = "Title block (\\maketitle) — from \\title, \\author, \\date";
    return card;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

/** The hidden preamble, standing in as one "Document settings" chip line. */
export class PreambleWidget extends WidgetType {
  constructor(
    readonly summary: string,
    readonly selected: boolean,
  ) {
    super();
  }

  override eq(other: PreambleWidget): boolean {
    return other.summary === this.summary && other.selected === this.selected;
  }

  override toDOM(): HTMLElement {
    const chip = el("div", "cm-vis-preamble");
    if (this.selected) chip.classList.add("cm-vis-card-selected");
    chip.appendChild(el("span", "cm-vis-preamble-icon", "⚙"));
    chip.appendChild(el("span", "cm-vis-preamble-text", this.summary));
    chip.title = "Document settings — click to view the preamble";
    return chip;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}
