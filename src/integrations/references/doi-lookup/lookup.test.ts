import { describe, expect, it } from "vitest";

import { classifyLookupInput } from "./lookup";

describe("classifyLookupInput", () => {
  it("recognizes bare DOIs", () => {
    expect(classifyLookupInput("10.1145/3290605.3300479")).toEqual({
      kind: "doi",
      id: "10.1145/3290605.3300479",
    });
  });

  it("strips the doi.org prefix from URLs", () => {
    expect(classifyLookupInput("https://doi.org/10.1038/nature12373")).toEqual({
      kind: "doi",
      id: "10.1038/nature12373",
    });
    expect(classifyLookupInput("https://dx.doi.org/10.1038/nature12373")).toEqual({
      kind: "doi",
      id: "10.1038/nature12373",
    });
  });

  it("recognizes modern arXiv ids", () => {
    expect(classifyLookupInput("2403.04132")).toEqual({
      kind: "arxiv",
      id: "2403.04132",
    });
    expect(classifyLookupInput("2403.04132v2")).toEqual({
      kind: "arxiv",
      id: "2403.04132v2",
    });
  });

  it("recognizes pre-2007 arXiv ids", () => {
    expect(classifyLookupInput("cs.LG/0507007")).toEqual({
      kind: "arxiv",
      id: "cs.LG/0507007",
    });
  });

  it("strips the arxiv.org prefix from URLs", () => {
    expect(classifyLookupInput("https://arxiv.org/abs/2403.04132")).toEqual({
      kind: "arxiv",
      id: "2403.04132",
    });
    expect(classifyLookupInput("https://arxiv.org/pdf/2403.04132v1")).toEqual({
      kind: "arxiv",
      id: "2403.04132v1",
    });
  });

  it("flags unrecognized input", () => {
    expect(classifyLookupInput("hello world")).toEqual({
      kind: "unknown",
      id: "hello world",
    });
    expect(classifyLookupInput("")).toEqual({ kind: "unknown", id: "" });
  });
});
