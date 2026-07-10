/**
 * Markdown rendering for assistant chat bubbles. AI output is remote content
 * per the threat model, so it goes through DOMPurify like every other HTML
 * sink, and `<a>`/`<img>` never render — no navigation, no beacons from model
 * output (link text still shows as plain text). markdown-it + DOMPurify ride
 * the existing lazy "markdown" vendor chunk (dynamic imports, same discipline
 * as MarkdownPreview) so the chat pane adds nothing to the boot path.
 */

let rendererPromise: Promise<(src: string) => string> | null = null;

async function loadRenderer(): Promise<(src: string) => string> {
  const [{ default: MarkdownIt }, { default: DOMPurify }] = await Promise.all([
    import("markdown-it"),
    import("dompurify"),
  ]);
  const md = new MarkdownIt({ html: false, linkify: false, typographer: false });
  // Links render as their text only; images collapse to their alt text.
  md.renderer.rules.link_open = () => "";
  md.renderer.rules.link_close = () => "";
  md.renderer.rules.image = (tokens, idx) =>
    md.utils.escapeHtml(tokens[idx]?.content ?? "");
  return (src: string) =>
    DOMPurify.sanitize(md.render(src), { FORBID_TAGS: ["a", "img"] });
}

export async function renderAssistantMarkdown(src: string): Promise<string> {
  rendererPromise ??= loadRenderer();
  const render = await rendererPromise;
  return render(src);
}

/**
 * Post-sanitization: attach a real-DOM copy affordance to each fenced block.
 * Buttons are created here with listeners — never injected through the HTML
 * sink — so the sanitized markup stays inert.
 */
export function decorateCodeBlocks(host: HTMLElement): void {
  for (const pre of Array.from(host.querySelectorAll("pre"))) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "ai-code-copy";
    btn.textContent = "Copy";
    btn.addEventListener("click", () => {
      const code = pre.querySelector("code")?.textContent ?? pre.textContent ?? "";
      void import("@tauri-apps/plugin-clipboard-manager")
        .then(({ writeText }) => writeText(code.replace(/\n$/, "")))
        .then(() => {
          btn.textContent = "Copied";
          setTimeout(() => {
            btn.textContent = "Copy";
          }, 1200);
        })
        .catch(() => {});
    });
    pre.appendChild(btn);
  }
}
