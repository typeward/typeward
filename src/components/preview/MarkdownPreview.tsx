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
