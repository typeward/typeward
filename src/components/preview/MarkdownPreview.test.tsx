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
});
