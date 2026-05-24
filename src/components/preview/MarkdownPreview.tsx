import DOMPurify from "dompurify";
import katex from "katex";
import MarkdownIt from "markdown-it";
import mdAnchor from "markdown-it-anchor";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import type { Accessor, Component } from "solid-js";
import { createEffect, createMemo, onCleanup } from "solid-js";

interface Props {
  content: Accessor<string>;
  baseDir: string;
  theme: Accessor<"dark" | "light">;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_IMAGE_PROTOCOLS = new Set(["http:", "https:"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i;

function renderMath(source: string, displayMode: boolean): string {
  return katex.renderToString(source, {
    displayMode,
    output: "html",
    strict: "ignore",
    throwOnError: false,
  });
}

function mathPlugin(md: MarkdownIt): void {
  md.inline.ruler.after("escape", "typeward_math", (state: StateInline, silent) => {
    if (state.src.charCodeAt(state.pos) !== 0x24) return false;
    if (state.pos > 0 && state.src.charCodeAt(state.pos - 1) === 0x5c) return false;

    const marker = state.src.charCodeAt(state.pos + 1) === 0x24 ? "$$" : "$";
    const contentStart = state.pos + marker.length;
    if (state.src.charCodeAt(contentStart) === 0x20) return false;

    let pos = contentStart;
    while (pos < state.posMax) {
      const close = state.src.indexOf(marker, pos);
      if (close < 0) return false;
      if (state.src.charCodeAt(close - 1) === 0x5c) {
        pos = close + marker.length;
        continue;
      }
      if (close === contentStart || state.src.charCodeAt(close - 1) === 0x20) return false;
      if (!silent) {
        const token = state.push(
          marker === "$$" ? "typeward_math_display" : "typeward_math_inline",
          marker === "$$" ? "div" : "span",
          0,
        );
        token.content = state.src.slice(contentStart, close);
        token.markup = marker;
      }
      state.pos = close + marker.length;
      return true;
    }

    return false;
  });

  md.renderer.rules.typeward_math_inline = (tokens, idx) =>
    renderMath(tokens[idx]?.content ?? "", false);
  md.renderer.rules.typeward_math_display = (tokens, idx) =>
    renderMath(tokens[idx]?.content ?? "", true);
}

function fileUrlFromPath(path: string): string {
  return `file://${path
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/")}`;
}

function safeRelativePath(url: string): string | null {
  const trimmed = url.trim().replace(/\\/g, "/");
  if (!trimmed || trimmed.startsWith("//") || trimmed.startsWith("/")) return null;

  const normalized = trimmed.replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (
    segments.some(
      (segment) => segment === "" || segment === "." || segment === ".." || segment.includes("\0"),
    )
  ) {
    return null;
  }
  return segments.join("/");
}

function sanitizeLinkUrl(url: string): string | null {
  const trimmed = url.trim();
  if (!trimmed) return null;
  if (trimmed.startsWith("#")) return trimmed;
  if (!URL_SCHEME.test(trimmed)) return safeRelativePath(trimmed);

  try {
    const parsed = new URL(trimmed);
    return SAFE_LINK_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? trimmed : null;
  } catch {
    return null;
  }
}

function buildMd(baseDir: string): MarkdownIt {
  const md = new MarkdownIt({
    html: false,
    linkify: true,
    typographer: false,
  })
    .use(mathPlugin)
    .use(mdAnchor, { tabIndex: false });

  md.validateLink = (url: string) => sanitizeLinkUrl(url) !== null;

  const rewriteImageUrl = (url: string): string | null => {
    const trimmed = url.trim();
    if (!trimmed) return null;
    if (SAFE_DATA_IMAGE.test(trimmed)) return trimmed;
    if (URL_SCHEME.test(trimmed)) {
      try {
        const parsed = new URL(trimmed);
        return SAFE_IMAGE_PROTOCOLS.has(parsed.protocol.toLowerCase()) ? trimmed : null;
      } catch {
        return null;
      }
    }

    const safeRel = safeRelativePath(trimmed);
    if (!safeRel) return null;
    const root = baseDir.replace(/\\/g, "/").replace(/\/+$/, "");
    return fileUrlFromPath(`${root}/${safeRel}`);
  };

  const origImage = md.renderer.rules.image;
  md.renderer.rules.image = (tokens, idx, opts, env, self) => {
    const token = tokens[idx];
    const srcAttr = token.attrIndex("src");
    if (srcAttr >= 0) {
      const rewritten = rewriteImageUrl(token.attrs![srcAttr]![1]);
      if (rewritten) {
        token.attrs![srcAttr]![1] = rewritten;
      } else {
        token.attrs!.splice(srcAttr, 1);
      }
    }
    return origImage
      ? origImage(tokens, idx, opts, env, self)
      : self.renderToken(tokens, idx, opts);
  };

  const origLink = md.renderer.rules.link_open;
  md.renderer.rules.link_open = (tokens, idx, opts, env, self) => {
    const token = tokens[idx] as Token;
    const hrefAttr = token.attrIndex("href");
    if (hrefAttr >= 0) {
      const sanitized = sanitizeLinkUrl(token.attrs![hrefAttr]![1]);
      if (sanitized) {
        token.attrs![hrefAttr]![1] = sanitized;
      } else {
        token.attrs!.splice(hrefAttr, 1);
      }
    }
    return origLink
      ? origLink(tokens, idx, opts, env, self)
      : self.renderToken(tokens, idx, opts);
  };
  return md;
}

export const MarkdownPreview: Component<Props> = (props) => {
  const md = createMemo(() => buildMd(props.baseDir));

  let host: HTMLDivElement | undefined;
  let timer: number | null = null;

  const renderContent = (source: string) => {
    if (!host) return;
    const dirty = md().render(source);
    host.innerHTML = DOMPurify.sanitize(dirty, {
      ADD_ATTR: ["target"],
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|tel|file):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
    });
  };

  createEffect(() => {
    const source = props.content();
    if (timer !== null) window.clearTimeout(timer);
    timer = window.setTimeout(() => renderContent(source), 80);
  });

  onCleanup(() => {
    if (timer !== null) window.clearTimeout(timer);
  });

  return (
    <div
      class="md-preview h-full w-full overflow-auto px-8 py-6 text-fg-1"
      classList={{
        "md-preview-dark": props.theme() === "dark",
        "md-preview-light": props.theme() === "light",
      }}
      ref={host}
    />
  );
};
