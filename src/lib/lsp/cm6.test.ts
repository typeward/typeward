import { EditorState, Text } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import {
  changesToLspContentChanges,
  cmOffsetToLspPos,
  kindToType,
  lspPosToOffset,
  lspToCmDiagnostic,
  pathToFileUri,
  sameDocumentUri,
  type LspDiagnostic,
} from "./cm6";

const viewFor = (doc: string): EditorView =>
  new EditorView({ state: EditorState.create({ doc }) });

describe("lspPosToOffset", () => {
  it("converts a zero-based LSP position to a CM6 document offset", () => {
    const view = viewFor("abc\ndef\nghi");
    // line 1 (0-based) char 1 => 'e' at absolute offset 5
    expect(lspPosToOffset({ line: 1, character: 1 }, view)).toBe(5);
    // start of doc
    expect(lspPosToOffset({ line: 0, character: 0 }, view)).toBe(0);
  });

  it("clamps an out-of-range character to the end of its line", () => {
    const view = viewFor("abc\ndef");
    const line = view.state.doc.line(1);
    // character past the line length must not spill past line.to
    expect(lspPosToOffset({ line: 0, character: 999 }, view)).toBe(line.to);
  });

  it("clamps an out-of-range line to the document length", () => {
    const view = viewFor("abc\ndef");
    expect(lspPosToOffset({ line: 50, character: 0 }, view)).toBe(
      view.state.doc.length,
    );
  });
});

describe("cmOffsetToLspPos", () => {
  it("converts a CM6 offset to a zero-based LSP position", () => {
    const view = viewFor("abc\ndef\nghi");
    // offset 5 is 'e' on the second line, char 1
    expect(cmOffsetToLspPos(5, view)).toEqual({ line: 1, character: 1 });
    expect(cmOffsetToLspPos(0, view)).toEqual({ line: 0, character: 0 });
  });

  it("round-trips offset -> LSP position -> offset for in-range positions", () => {
    const view = viewFor("hello\nworld\nfoo bar\n");
    for (let offset = 0; offset <= view.state.doc.length; offset++) {
      const pos = cmOffsetToLspPos(offset, view);
      expect(lspPosToOffset(pos, view)).toBe(offset);
    }
  });
});

describe("changesToLspContentChanges", () => {
  // Applying the emitted content-changes to startDoc (in the order given, each
  // range against the doc resulting from the prior changes) must reproduce the
  // final document — the LSP mirror contract. We simulate that here.
  const applyLsp = (
    startText: string,
    changes: Array<{ range: { start: { line: number; character: number }; end: { line: number; character: number } }; text: string }>,
  ): string => {
    let doc = Text.of(startText.split("\n"));
    for (const c of changes) {
      const from = doc.line(c.range.start.line + 1).from + c.range.start.character;
      const to = doc.line(c.range.end.line + 1).from + c.range.end.character;
      doc = doc.replace(from, to, Text.of(c.text.split("\n")));
    }
    return doc.toString();
  };

  it("reproduces a single insertion", () => {
    const start = Text.of(["hello world"]);
    const cs = EditorState.create({ doc: "hello world" }).changes({ from: 5, insert: " brave" });
    const lsp = changesToLspContentChanges(cs, start);
    expect(applyLsp("hello world", lsp as never)).toBe("hello brave world");
  });

  it("reproduces multiple edits in one changeset applied top-to-bottom", () => {
    const startStr = "aaa\nbbb\nccc";
    const start = Text.of(startStr.split("\n"));
    // Two edits: delete the first char of line 1, insert 'X' at end of line 3.
    const cs = EditorState.create({ doc: startStr }).changes([
      { from: 0, to: 1 },
      { from: startStr.length, insert: "X" },
    ]);
    const lsp = changesToLspContentChanges(cs, start);
    // Highest-position-first ordering: the line-3 insert must precede the
    // line-1 delete so its range stays valid.
    expect(lsp[0].range.start).toEqual({ line: 2, character: 3 });
    expect(applyLsp(startStr, lsp as never)).toBe("aa\nbbb\ncccX");
  });

  it("reproduces a composed multi-keystroke window", () => {
    const startStr = "x = 1\ny = 2";
    let state = EditorState.create({ doc: startStr });
    // Simulate three keystrokes typed into line 1, composing the changesets.
    let composed = state.changes({ from: 5, insert: "0" });
    state = state.update({ changes: composed }).state;
    let c2 = state.changes({ from: 6, insert: "0" });
    composed = composed.compose(c2);
    state = state.update({ changes: c2 }).state;
    const c3 = state.changes({ from: 7, insert: "0" });
    composed = composed.compose(c3);
    const lsp = changesToLspContentChanges(composed, Text.of(startStr.split("\n")));
    expect(applyLsp(startStr, lsp as never)).toBe("x = 1000\ny = 2");
  });
});

describe("pathToFileUri", () => {
  it("builds a triple-slash URI with a drive letter for Windows paths", () => {
    expect(pathToFileUri("C:\\Users\\me\\main.tex")).toBe(
      "file:///C:/Users/me/main.tex",
    );
  });

  it("builds a file:// URI for POSIX absolute paths", () => {
    expect(pathToFileUri("/home/me/main.tex")).toBe("file:///home/me/main.tex");
  });

  it("normalizes backslashes in already-forward paths without a drive", () => {
    expect(pathToFileUri("/a\\b/c")).toBe("file:///a/b/c");
  });

  // Servers parse our URI with a WHATWG parser and echo the normalized spelling
  // on publishDiagnostics. An unencoded space never string-equalled the raw URI
  // we registered, so users whose path contains one ("C:\Users\John Smith\...",
  // "OneDrive - Company") silently got zero diagnostics.
  it("percent-encodes spaces and non-ASCII so the server's echo matches", () => {
    expect(pathToFileUri("C:\\Users\\John Smith\\main.tex")).toBe(
      "file:///C:/Users/John%20Smith/main.tex",
    );
    expect(pathToFileUri("/home/josé/main.tex")).toBe(
      "file:///home/jos%C3%A9/main.tex",
    );
  });

  // '#' and '?' are URI delimiters: unescaped, they truncate the path and the
  // server resolves an entirely different document.
  it("escapes characters that would otherwise change the URI structure", () => {
    expect(pathToFileUri("/a/b#c/main.tex")).toBe(
      "file:///a/b%23c/main.tex",
    );
    expect(pathToFileUri("/a/b?c/main.tex")).toBe(
      "file:///a/b%3Fc/main.tex",
    );
    // A literal '%' must not be re-read as an escape sequence.
    expect(pathToFileUri("/a/100%25/main.tex")).toBe(
      "file:///a/100%2525/main.tex",
    );
  });
});

describe("sameDocumentUri", () => {
  it("matches identical URIs", () => {
    expect(sameDocumentUri("file:///a/b.tex", "file:///a/b.tex")).toBe(true);
  });

  it("matches equivalent spellings that differ only in escaping", () => {
    // Implementations disagree on which sub-delimiters to escape; the
    // diagnostics filter must not drop a notification over that.
    expect(
      sameDocumentUri("file:///a/b%40c.tex", "file:///a/b@c.tex"),
    ).toBe(true);
    expect(
      sameDocumentUri("file:///a/x%20y.tex", "file:///a/x y.tex"),
    ).toBe(true);
  });

  it("does not match different documents", () => {
    expect(sameDocumentUri("file:///a/b.tex", "file:///a/c.tex")).toBe(false);
  });
});

describe("lspToCmDiagnostic", () => {
  const diag = (severity: LspDiagnostic["severity"]): LspDiagnostic => ({
    range: {
      start: { line: 0, character: 1 },
      end: { line: 0, character: 3 },
    },
    severity,
    message: "boom",
    source: "texlab",
  });

  it("maps LSP ranges to CM6 from/to offsets and preserves message/source", () => {
    const view = viewFor("abcdef");
    const cm = lspToCmDiagnostic(diag(1), view);
    expect(cm).not.toBeNull();
    expect(cm).toMatchObject({
      from: 1,
      to: 3,
      severity: "error",
      message: "boom",
      source: "texlab",
    });
  });

  it("maps LSP severity codes onto CM6 severity strings", () => {
    const view = viewFor("abcdef");
    expect(lspToCmDiagnostic(diag(1), view)?.severity).toBe("error");
    expect(lspToCmDiagnostic(diag(2), view)?.severity).toBe("warning");
    expect(lspToCmDiagnostic(diag(3), view)?.severity).toBe("info");
    expect(lspToCmDiagnostic(diag(4), view)?.severity).toBe("info");
    expect(lspToCmDiagnostic(diag(undefined), view)?.severity).toBe("error");
  });

  it("guards against an inverted range by clamping to >= from", () => {
    const view = viewFor("abcdef");
    const inverted: LspDiagnostic = {
      range: {
        start: { line: 0, character: 4 },
        end: { line: 0, character: 1 },
      },
      message: "reversed",
    };
    const cm = lspToCmDiagnostic(inverted, view);
    expect(cm?.from).toBe(4);
    expect(cm?.to).toBe(4);
  });
});

describe("kindToType", () => {
  it("maps the known LSP CompletionItemKind subset", () => {
    expect(kindToType(3)).toBe("function");
    expect(kindToType(6)).toBe("variable");
    expect(kindToType(7)).toBe("class");
    expect(kindToType(14)).toBe("keyword");
    expect(kindToType(15)).toBe("constant");
    expect(kindToType(17)).toBe("type");
    expect(kindToType(21)).toBe("constant");
  });

  it("falls back to text for unknown or missing kinds", () => {
    expect(kindToType(999)).toBe("text");
    expect(kindToType(undefined)).toBe("text");
  });
});
