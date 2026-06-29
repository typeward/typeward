import { StreamLanguage, type StreamParser } from "@codemirror/language";

/**
 * Minimal Typst tokenizer for CodeMirror 6.
 *
 * Typst's surface grammar is rich (script mode vs markup mode, nested
 * code blocks via `#{ ... }`, content-mode interpolation), and any full
 * parser would be substantial. This `StreamLanguage` covers the visual
 * basics needed for an editing experience that doesn't look like plain
 * text: comments, strings, math, function/variable hashes, headings,
 * basic emphasis, and brackets.
 *
 * Token names map onto the same @lezer/highlight tags used by the LaTeX
 * highlight style in CodeMirror.tsx so colors are consistent without an
 * extra HighlightStyle.
 */

interface TypstState {
  /** True inside a $...$ math run. */
  inMath: boolean;
}

const typstParser: StreamParser<TypstState> = {
  startState: () => ({ inMath: false }),

  token(stream, state) {
    // Math mode swallows everything between $ delimiters.
    if (state.inMath) {
      if (stream.eat("$")) {
        state.inMath = false;
        return "string";
      }
      // Consume the whole run up to the closing `$` as one token. The close
      // is handled by the eat above, so this always advances by ≥1 char.
      stream.eatWhile((c) => c !== "$");
      return "atom";
    }

    if (stream.eatSpace()) return null;

    // Line comments.
    if (stream.match("//")) {
      stream.skipToEnd();
      return "comment";
    }

    // Block comments.
    if (stream.match("/*")) {
      while (!stream.eol()) {
        if (stream.match("*/")) return "comment";
        stream.next();
      }
      return "comment";
    }

    // Math: enter math mode at the opening $.
    if (stream.eat("$")) {
      state.inMath = true;
      return "string";
    }

    // Double-quoted string literals (script mode).
    if (stream.match(/^"(?:[^"\\]|\\.)*"/)) {
      return "string";
    }

    // Headings: leading `=` characters at the start of a line.
    if (stream.sol() && stream.match(/^=+\s/)) {
      stream.skipToEnd();
      return "tagName";
    }

    // List markers at the start of a line: `- `, `+ `, `/ `.
    if (stream.sol() && stream.match(/^[-+/]\s/)) {
      return "punctuation";
    }

    // Script entry: `#name`, `#let`, `#if`, etc.
    if (stream.eat("#")) {
      stream.eatWhile(/[\w-]/);
      return "keyword";
    }

    // Emphasis (single underscore) and strong (single asterisk). Naive —
    // doesn't handle nesting, but covers the most common visual case.
    if (stream.match(/^\*[^*\n]+\*/)) return "strong";
    if (stream.match(/^_[^_\n]+_/)) return "emphasis";

    // Brackets and parens.
    if (stream.eat(/[\[\](){}]/)) return "bracket";

    // Numbers.
    if (stream.match(/^\d+(\.\d+)?/)) return "number";

    // Identifiers / words.
    if (stream.match(/^[A-Za-z_][\w-]*/)) return null;

    stream.next();
    return null;
  },

  languageData: {
    commentTokens: { line: "//", block: { open: "/*", close: "*/" } },
    closeBrackets: { brackets: ["(", "[", "{", "$", '"'] },
  },
};

export const typst = () => StreamLanguage.define(typstParser);
