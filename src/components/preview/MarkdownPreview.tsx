import DOMPurify from "dompurify";
import katex from "katex";
import "katex/dist/katex.min.css";
import MarkdownIt from "markdown-it";
import mdAnchor from "markdown-it-anchor";
import type StateInline from "markdown-it/lib/rules_inline/state_inline.mjs";
import type Token from "markdown-it/lib/token.mjs";
import type { Accessor, Component } from "solid-js";
import { createEffect, createMemo, onCleanup } from "solid-js";
import { openUrl } from "@tauri-apps/plugin-opener";
import { fileUrlFromPath, safeRelativePath } from "~/lib/file-url";
import { notifyInfo } from "~/lib/toast";

interface Props {
  content: Accessor<string>;
  baseDir: string;
  theme: Accessor<"dark" | "light">;
}

const URL_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
const SAFE_LINK_PROTOCOLS = new Set(["http:", "https:", "mailto:", "tel:"]);
const SAFE_DATA_IMAGE = /^data:image\/(?:png|jpeg|gif|webp);base64,[a-z0-9+/]+=*$/i;

// KaTeX dominates the render pipeline cost, and every debounced pass re-renders
// all math tokens even when only prose changed — memoize per formula. Cached
// values still flow through DOMPurify.sanitize in renderContent like fresh ones.
// throwOnError: false means error-fallback HTML is cached the same as success.
const mathCache = new Map<string, string>();
const MATH_CACHE_MAX = 500;

function renderMath(source: string, displayMode: boolean): string {
  const key = (displayMode ? "D:" : "I:") + source;
  const cached = mathCache.get(key);
  if (cached !== undefined) return cached;

  const html = katex.renderToString(source, {
    displayMode,
    output: "html",
    strict: "ignore",
    throwOnError: false,
  });
  if (mathCache.size >= MATH_CACHE_MAX) {
    mathCache.delete(mathCache.keys().next().value!);
  }
  mathCache.set(key, html);
  return html;
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

// Shared with the visual editor's figure widgets — the guarded-relative-
// asset security posture lives in one module (src/lib/file-url.ts).

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
    // Remote (and any explicit-scheme) images are dropped: a malicious project
    // .md could otherwise beacon the user's IP / open-time to an attacker via
    // <img src>. Only data: images and local project-relative figures render.
    if (URL_SCHEME.test(trimmed)) return null;

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
        // Unresolvable / remote image: swap in a text placeholder rather than
        // emit a src-less <img> (broken icon) or load a remote beacon. The
        // rejected URL itself is never echoed back into the document.
        return `<span class="md-img-blocked">[image not shown: ${md.utils.escapeHtml(token.content || "")}]</span>`;
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
      // `asset:` because convertFileSrc yields `asset://localhost/...` on
      // macOS/Linux (only Windows gets `http://asset.localhost/...`) — without
      // it every project-relative image's rewritten src is stripped here.
      // Rewritten srcs are funneled through safeRelativePath + fileUrlFromPath
      // first, so allowing the scheme doesn't widen what a document can name.
      ALLOWED_URI_REGEXP:
        /^(?:(?:https?|mailto|tel|file|asset):|[^a-z]|[a-z+.-]+(?:[^a-z+.\-:]|$))/i,
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

  // Links in this pane come from untrusted document content, and letting the
  // webview follow one is unrecoverable: the window has no address bar or back
  // button, so an external link replaces the whole app with attacker content
  // (a convincing phish of our own credential screens), and even a benign
  // relative link like `[notes](notes.md)` navigates to a path the asset
  // resolver 404s, blanking the running app. Rust's navigation-guard plugin is
  // the structural backstop; this handler is what makes the click do something
  // *useful* instead of silently nothing.
  const onLinkClick = (e: MouseEvent) => {
    const target = e.target as Element | null;
    const anchor = target?.closest?.("a[href]");
    if (!anchor) return;
    const href = anchor.getAttribute("href") ?? "";
    // In-document anchors are the one kind that may resolve natively.
    if (href.startsWith("#")) return;
    e.preventDefault();
    if (!/^https?:/i.test(href)) return;
    void openUrl(href).catch(() => {
      notifyInfo("Link not opened", href);
    });
  };

  return (
    <div
      class="md-preview scroll h-full w-full overflow-auto px-8 py-6 text-fg-1"
      classList={{
        "md-preview-dark": props.theme() === "dark",
        "md-preview-light": props.theme() === "light",
      }}
      onClick={onLinkClick}
      ref={host}
    />
  );
};
