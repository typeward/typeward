import { describe, expect, it } from "vitest";
import { labelKeyAtCursor } from "./label-key";

/** Key resolved with the cursor at the `|` marker. */
function at(src: string): string | null {
  const pos = src.indexOf("|");
  return labelKeyAtCursor(src.replace("|", ""), pos);
}

describe("labelKeyAtCursor", () => {
  it("reads the key inside a \\label", () => {
    expect(at("\\label{fig:a|}")).toBe("fig:a");
  });

  it("reads the key inside ref-family commands", () => {
    expect(at("\\ref{sec:in|tro}")).toBe("sec:intro");
    expect(at("\\eqref{eq:eu|ler}")).toBe("eq:euler");
    expect(at("\\cref{fig:pl|ot}")).toBe("fig:plot");
  });

  it("picks the comma segment under the cursor", () => {
    expect(at("\\cref{a,mid|dle,b}")).toBe("middle");
    expect(at("\\cref{fir|st,b}")).toBe("first");
  });

  it("returns null off a label/ref command", () => {
    expect(at("plain te|xt")).toBeNull();
    expect(at("\\cite{k|ey}")).toBeNull(); // cite is a different namespace
    expect(at("\\section{ti|tle}")).toBeNull();
  });

  it("returns null after the closing brace", () => {
    expect(at("\\label{a}|")).toBeNull();
  });
});
