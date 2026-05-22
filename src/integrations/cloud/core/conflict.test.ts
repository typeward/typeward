import { describe, expect, it } from "vitest";

import { decideConflict, suffixWithConflict } from "./conflict";

describe("suffixWithConflict", () => {
  const at = Date.UTC(2026, 4, 22, 18, 30, 0);

  it("inserts the suffix before the extension", () => {
    expect(suffixWithConflict("main.tex", at)).toBe(
      "main.conflict-2026-05-22T18-30-00-000Z.tex",
    );
  });

  it("handles nested paths", () => {
    expect(suffixWithConflict("fig/diagram.png", at)).toBe(
      "fig/diagram.conflict-2026-05-22T18-30-00-000Z.png",
    );
  });

  it("appends when there's no extension", () => {
    expect(suffixWithConflict("Makefile", at)).toBe(
      "Makefile.conflict-2026-05-22T18-30-00-000Z",
    );
  });

  it("ignores dotfiles' leading dot for extension detection", () => {
    expect(suffixWithConflict(".env", at)).toBe(
      ".env.conflict-2026-05-22T18-30-00-000Z",
    );
  });
});

describe("decideConflict", () => {
  it("local wins when its mtime is newer", () => {
    const decision = decideConflict("main.tex", 200, 100, 0);
    expect(decision.winner).toBe("local");
  });

  it("remote wins when its mtime is newer", () => {
    const decision = decideConflict("main.tex", 100, 200, 0);
    expect(decision.winner).toBe("remote");
  });

  it("ties go to local (deterministic — user's recent work wins)", () => {
    const decision = decideConflict("main.tex", 100, 100, 0);
    expect(decision.winner).toBe("local");
  });

  it("returns a conflict path beside the original", () => {
    const decision = decideConflict("fig/x.png", 200, 100, Date.UTC(2026, 4, 22));
    expect(decision.conflictPath).toMatch(/^fig\/x\.conflict-.+\.png$/);
  });
});
