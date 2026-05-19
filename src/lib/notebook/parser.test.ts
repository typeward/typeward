import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetIdsForTests,
  blankCodeCell,
  blankMarkdownCell,
  parseNotebook,
  serializeNotebook,
} from "./parser";

beforeEach(() => {
  _resetIdsForTests();
});

describe("parseNotebook", () => {
  it("returns a single empty markdown cell for empty input", () => {
    const cells = parseNotebook("");
    expect(cells).toHaveLength(1);
    expect(cells[0].kind).toBe("markdown");
    expect(cells[0].kind === "markdown" && cells[0].content).toBe("");
  });

  it("extracts a YAML frontmatter metadata cell", () => {
    const source = '---\ntitle: "Hello"\nauthor: M\n---\n\n# Body\n';
    const cells = parseNotebook(source);
    expect(cells[0].kind).toBe("metadata");
    expect(cells[0].kind === "metadata" && cells[0].content).toBe(
      'title: "Hello"\nauthor: M',
    );
    expect(cells[1].kind).toBe("markdown");
  });

  it("ignores `---` outside the document start", () => {
    // A `---` partway through is just markdown (a horizontal rule).
    const source = "# Body\n\n---\n\nMore prose\n";
    const cells = parseNotebook(source);
    expect(cells.every((c) => c.kind === "markdown")).toBe(true);
    expect(cells).toHaveLength(1);
  });

  it("parses an R chunk into a code cell with language and content", () => {
    const source = "```{r}\nsummary(cars)\n```\n";
    const cells = parseNotebook(source);
    expect(cells).toHaveLength(1);
    expect(cells[0].kind).toBe("code");
    if (cells[0].kind === "code") {
      expect(cells[0].language).toBe("r");
      expect(cells[0].content).toBe("summary(cars)");
      expect(cells[0].options).toBe("");
    }
  });

  it("preserves chunk options for round-trip", () => {
    const source = "```{r, echo=FALSE, fig.width=5}\nplot(cars)\n```\n";
    const cells = parseNotebook(source);
    expect(cells[0].kind).toBe("code");
    if (cells[0].kind === "code") {
      expect(cells[0].options).toBe(", echo=FALSE, fig.width=5");
    }
  });

  it("alternates prose and code cells", () => {
    const source =
      "# Intro\n\nProse here.\n\n```{r}\nx <- 1\n```\n\nMore prose.\n\n```{python}\nprint('hi')\n```\n";
    const cells = parseNotebook(source);
    expect(cells.map((c) => c.kind)).toEqual([
      "markdown",
      "code",
      "markdown",
      "code",
    ]);
    expect(cells[3].kind === "code" && cells[3].language).toBe("python");
  });

  it("tolerates an unclosed fence at EOF", () => {
    const source = "```{r}\nfoo\nbar\n";
    const cells = parseNotebook(source);
    expect(cells).toHaveLength(1);
    expect(cells[0].kind).toBe("code");
    if (cells[0].kind === "code") {
      expect(cells[0].content).toBe("foo\nbar");
    }
  });
});

describe("round-trip parse → serialize", () => {
  it("metadata + prose + code round-trips stably", () => {
    const source =
      '---\ntitle: "Demo"\noutput: pdf_document\n---\n\nIntro paragraph.\n\n```{r}\nsummary(cars)\n```\n\nClosing line.\n';
    const first = serializeNotebook(parseNotebook(source));
    const second = serializeNotebook(parseNotebook(first));
    // Round-trip should be idempotent after the first parse+serialize.
    expect(second).toBe(first);
  });

  it("preserves chunk language case (lowercased)", () => {
    const source = "```{R}\nx <- 1\n```\n";
    const out = serializeNotebook(parseNotebook(source));
    expect(out).toContain("```{r}");
  });
});

describe("blank cell builders", () => {
  it("blankMarkdownCell creates an empty markdown cell with a fresh id", () => {
    const a = blankMarkdownCell();
    const b = blankMarkdownCell();
    expect(a.id).not.toBe(b.id);
    expect(a.kind).toBe("markdown");
    expect(a.content).toBe("");
  });

  it("blankCodeCell defaults to language r", () => {
    expect(blankCodeCell().language).toBe("r");
    expect(blankCodeCell("python").language).toBe("python");
  });
});
