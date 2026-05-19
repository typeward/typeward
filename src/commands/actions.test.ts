import { describe, expect, it } from "vitest";
import { pathRelativeToProjectRoot } from "./actions";

describe("pathRelativeToProjectRoot", () => {
  it("does not treat sibling paths with a shared prefix as project children", () => {
    expect(pathRelativeToProjectRoot("/home/me/project", "/home/me/project-copy/main.tex"))
      .toBeNull();
  });

  it("returns a relative path for files under the project root", () => {
    expect(pathRelativeToProjectRoot("/home/me/project", "/home/me/project/sections/a.tex"))
      .toBe("sections/a.tex");
  });
});
