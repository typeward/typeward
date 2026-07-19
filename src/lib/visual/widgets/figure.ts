/**
 * Read-only figure widget: image preview + caption. Path resolution goes
 * through the host-provided resolver (project-root-anchored, guarded by
 * src/lib/file-url.ts — absolute paths and traversal never resolve).
 */

import { WidgetType } from "@codemirror/view";

export interface ParsedFigure {
  /** Project-relative image path from \includegraphics, if present. */
  imagePath: string | null;
  caption: string | null;
  /** Approximate width fraction from `width=0.8\linewidth`, if present. */
  widthFraction: number | null;
}

export function parseFigure(body: string): ParsedFigure {
  const img = /\\includegraphics\s*(?:\[([^\]]*)\])?\s*\{([^{}]*)\}/.exec(body);
  const captionMatch = /\\caption\{([^{}]*)\}/.exec(body);
  let widthFraction: number | null = null;
  if (img?.[1]) {
    const w = /width\s*=\s*([0-9.]+)\s*\\(?:line|text|column)width/.exec(img[1]);
    if (w) {
      const f = Number.parseFloat(w[1]);
      if (Number.isFinite(f) && f > 0 && f <= 1) widthFraction = f;
    }
  }
  return {
    imagePath: img ? img[2].trim() : null,
    caption: captionMatch ? captionMatch[1] : null,
    widthFraction,
  };
}

const RENDERABLE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|avif)$/i;

export class FigureWidget extends WidgetType {
  constructor(
    readonly figure: ParsedFigure,
    /** Resolved file URL, or null (unresolvable / non-renderable format). */
    readonly src: string | null,
    readonly sourceKey: string,
  ) {
    super();
  }

  override eq(other: FigureWidget): boolean {
    return other.sourceKey === this.sourceKey && other.src === this.src;
  }

  override toDOM(): HTMLElement {
    const wrap = document.createElement("div");
    wrap.className = "cm-vis-figure";
    wrap.title = "Click to edit";
    if (this.src) {
      const img = document.createElement("img");
      img.src = this.src;
      img.alt = this.figure.caption ?? this.figure.imagePath ?? "figure";
      img.draggable = false;
      if (this.figure.widthFraction !== null) {
        img.style.width = `${Math.round(this.figure.widthFraction * 100)}%`;
      }
      img.onerror = () => {
        img.remove();
        wrap.prepend(placeholder(this.figure.imagePath));
      };
      wrap.appendChild(img);
    } else {
      wrap.appendChild(placeholder(this.figure.imagePath));
    }
    if (this.figure.caption) {
      const cap = document.createElement("div");
      cap.className = "cm-vis-figcaption";
      cap.textContent = this.figure.caption;
      wrap.appendChild(cap);
    }
    return wrap;
  }

  override ignoreEvent(): boolean {
    return false;
  }
}

export function isRenderableImage(path: string): boolean {
  return RENDERABLE_EXT.test(path);
}

function placeholder(path: string | null): HTMLElement {
  const box = document.createElement("div");
  box.className = "cm-vis-figure-placeholder";
  box.textContent = path === null ? "🖼 figure" : `🖼 ${path}`;
  return box;
}
