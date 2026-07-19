import { describe, expect, it } from "vitest";
import { matchTier, scoreFields } from "./fuzzy";

describe("matchTier", () => {
  it("matches a subsequence like 'svfl' against 'Save file'", () => {
    expect(matchTier("svfl", "Save file")).not.toBeNull();
  });

  it("ranks word-prefix > substring > subsequence", () => {
    const prefix = matchTier("save", "Save and compile")!;
    const wordPrefix = matchTier("file", "Go to file")!;
    const substring = matchTier("ave", "Save and compile")!;
    const subsequence = matchTier("svfl", "Save file")!;
    expect(prefix).toBe(wordPrefix);
    expect(prefix).toBeGreaterThan(substring);
    expect(substring).toBeGreaterThan(subsequence);
  });

  it("returns null when the query is not even a subsequence", () => {
    expect(matchTier("xyz", "Save file")).toBeNull();
  });

  it("matches everything at tier 0 on an empty query", () => {
    expect(matchTier("", "anything")).toBe(0);
  });

  it("is case-insensitive", () => {
    expect(matchTier("SAVE", "save file")).toBe(matchTier("save", "Save file"));
  });
});

describe("scoreFields", () => {
  const title = (text: string) => ({ text, weight: 1 });
  const subtitle = (text: string) => ({ text, weight: 0.7 });

  it("returns null when no field matches", () => {
    expect(scoreFields("zzz", [title("Save file"), subtitle("persist")])).toBeNull();
  });

  it("returns 0 for an empty query (match-all)", () => {
    expect(scoreFields("", [title("Save file")])).toBe(0);
  });

  it("weights a title hit above the same hit on a subtitle", () => {
    const onTitle = scoreFields("save", [title("Save file")])!;
    const onSubtitle = scoreFields("save", [title("Compile"), subtitle("Save file")])!;
    expect(onTitle).toBeGreaterThan(onSubtitle);
  });

  it("skips empty/undefined fields", () => {
    expect(
      scoreFields("save", [{ text: undefined, weight: 1 }, subtitle("Save file")]),
    ).toBe(scoreFields("save", [subtitle("Save file")]));
  });

  it("breaks ties toward the shorter text", () => {
    const short = scoreFields("save", [title("Save")])!;
    const long = scoreFields("save", [title("Save and compile everything")])!;
    expect(short).toBeGreaterThan(long);
  });

  it("never lets the length penalty flip a tier", () => {
    // A very long word-prefix title must still beat a short subsequence one.
    const longPrefix = scoreFields("save", [
      title("Save absolutely everything in the entire project right now"),
    ])!;
    const shortSubsequence = scoreFields("save", [title("Snapshot view")])!;
    expect(longPrefix).toBeGreaterThan(shortSubsequence);
  });
});
