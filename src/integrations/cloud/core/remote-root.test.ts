import { describe, expect, it } from "vitest";

import { remoteFolderSegment, remoteProjectFolder } from "./remote-root";

describe("remoteFolderSegment", () => {
  it("keeps an ordinary name intact", () => {
    expect(remoteFolderSegment("My Thesis")).toBe("My Thesis");
  });

  it("folds separators so one name can never become two path components", () => {
    expect(remoteFolderSegment("chapters/2024")).toBe("chapters-2024");
    expect(remoteFolderSegment("a\\b")).toBe("a-b");
    expect(remoteFolderSegment("../escape")).toBe("-escape");
  });

  it("drops the characters Windows rejects or silently trims", () => {
    expect(remoteFolderSegment('draft: "final"?')).toBe("draft- -final--");
    expect(remoteFolderSegment("  spaced  ")).toBe("spaced");
    expect(remoteFolderSegment("trailing.")).toBe("trailing");
  });

  it("falls back rather than yielding an empty segment", () => {
    expect(remoteFolderSegment("...")).toBe("Untitled project");
    expect(remoteFolderSegment("   ")).toBe("Untitled project");
  });
});

describe("remoteProjectFolder", () => {
  it("nests the project under the shared Typeward folder", () => {
    expect(remoteProjectFolder("My Thesis")).toEqual({
      id: "Typeward/My Thesis",
      name: "My Thesis",
    });
  });
});
