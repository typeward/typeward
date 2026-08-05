import { render, waitFor } from "@solidjs/testing-library";
import { createSignal } from "solid-js";
import { describe, expect, it } from "vitest";
import { MarkdownPreview } from "./MarkdownPreview";

describe("MarkdownPreview", () => {
  it("renders headings as <h1>", async () => {
    const [content] = createSignal("# Hello\n\nbody");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector("h1")?.textContent).toBe("Hello");
    });
  });

  it("renders inline math via KaTeX", async () => {
    const [content] = createSignal("Energy is $E = mc^2$.");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector(".katex")).not.toBeNull();
    });
  });

  it("renders display math via KaTeX", async () => {
    const [content] = createSignal("$$E = mc^2$$");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector(".katex-display")).not.toBeNull();
    });
  });

  it("strips <script> via DOMPurify", async () => {
    const [content] = createSignal("hello\n\n<script>window.x=1</script>");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/tmp" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector("p")?.textContent).toContain("hello");
    });
    expect(container.querySelector("script")).toBeNull();
  });

  it("rewrites relative <img src> against baseDir", async () => {
    const [content] = createSignal("![alt](./pic.png)");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/proj/sub" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.querySelector("img")?.getAttribute("src")).toBe(
        "file:///proj/sub/pic.png",
      );
    });
  });

  it("drops image paths that escape the markdown file directory", async () => {
    const [content] = createSignal("![alt](../secret.png)");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/proj/sub" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.textContent).toContain("![alt](../secret.png)");
    });
    expect(container.querySelector("img")).toBeNull();
  });

  it("drops direct file URLs from links and images", async () => {
    const [content] = createSignal("[x](file:///etc/passwd)\n\n![alt](file:///etc/passwd)");
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/proj/sub" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.textContent).toContain("[x](file:///etc/passwd)");
    });
    expect(container.querySelector("a")).toBeNull();
    expect(container.querySelector("img")).toBeNull();
  });

  it("drops remote http(s) images (no phone-home from untrusted content)", async () => {
    const [content] = createSignal(
      "before ![alt](https://attacker.example/track.png) after",
    );
    const { container } = render(() => (
      <MarkdownPreview content={content} baseDir="/proj/sub" theme={() => "dark"} />
    ));
    await waitFor(() => {
      expect(container.textContent).toContain("before");
    });
    expect(container.textContent).toContain("after");
    expect(container.querySelector("img")).toBeNull();
  });

  // Letting the webview follow a link from untrusted document content replaces
  // the whole app: the window has no address bar or back button, so an external
  // link is an unrecoverable phishing surface, and even a benign relative link
  // navigates to a path the asset resolver 404s, blanking the running app.
  describe("link clicks never navigate the app shell", () => {
    it("cancels navigation for an external link", async () => {
      const [content] = createSignal("[click](https://attacker.example/phish)");
      const { container } = render(() => (
        <MarkdownPreview content={content} baseDir="/proj" theme={() => "dark"} />
      ));
      let anchor: HTMLAnchorElement | null = null;
      await waitFor(() => {
        anchor = container.querySelector("a");
        expect(anchor).not.toBeNull();
      });
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });

    it("cancels navigation for a relative link", async () => {
      const [content] = createSignal("[notes](notes.md)");
      const { container } = render(() => (
        <MarkdownPreview content={content} baseDir="/proj" theme={() => "dark"} />
      ));
      let anchor: HTMLAnchorElement | null = null;
      await waitFor(() => {
        anchor = container.querySelector("a");
        expect(anchor).not.toBeNull();
      });
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(true);
    });

    it("leaves in-document anchors alone so headings still jump", async () => {
      const [content] = createSignal("# Title\n\n[to top](#title)");
      const { container } = render(() => (
        <MarkdownPreview content={content} baseDir="/proj" theme={() => "dark"} />
      ));
      let anchor: HTMLAnchorElement | null = null;
      await waitFor(() => {
        anchor = container.querySelector('a[href^="#"]');
        expect(anchor).not.toBeNull();
      });
      const ev = new MouseEvent("click", { bubbles: true, cancelable: true });
      anchor!.dispatchEvent(ev);
      expect(ev.defaultPrevented).toBe(false);
    });
  });
});
