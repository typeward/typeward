import { describe, expect, it } from "vitest";

import { parseNextLink } from "./provider";

describe("parseNextLink", () => {
  it("extracts the rel=next cursor URL from a Mendeley Link header", () => {
    const link =
      '<https://api.mendeley.com/documents?limit=500&view=bib&marker=abc-123>; rel="next", ' +
      '<https://api.mendeley.com/documents?limit=500&view=bib&marker=zzz>; rel="last"';
    expect(parseNextLink(link)).toBe(
      "https://api.mendeley.com/documents?limit=500&view=bib&marker=abc-123",
    );
  });

  it("returns null when there is no next relation", () => {
    expect(parseNextLink(undefined)).toBeNull();
    expect(parseNextLink("")).toBeNull();
    expect(
      parseNextLink('<https://api.mendeley.com/documents?marker=x>; rel="prev"'),
    ).toBeNull();
  });

  it("handles loose whitespace and unquoted rel", () => {
    expect(parseNextLink("<https://api.mendeley.com/x?marker=1> ; rel=next")).toBe(
      "https://api.mendeley.com/x?marker=1",
    );
  });
});
