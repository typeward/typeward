import { describe, it, expect, vi, afterEach } from "vitest";
import { EditorView } from "@codemirror/view";
import {
  reviewExtension,
  dispatchSetThreads,
  getCurrentRanges,
  type ReviewExtensionCallbacks,
} from "~/lib/reviews/cm6";

type OffsetUpdate = {
  id: string;
  from: number;
  to: number;
  anchorText: string;
};

function makeView(
  doc: string,
  callbacks?: Partial<ReviewExtensionCallbacks>,
): { view: EditorView; offsetCalls: OffsetUpdate[][] } {
  const offsetCalls: OffsetUpdate[][] = [];
  const cbs: ReviewExtensionCallbacks = {
    onOffsetsChanged: callbacks?.onOffsetsChanged ?? ((u) => offsetCalls.push(u)),
    onGutterClick: callbacks?.onGutterClick ?? (() => {}),
  };
  const view = new EditorView({
    doc,
    extensions: reviewExtension(cbs),
    parent: document.body,
  });
  return { view, offsetCalls };
}

const DOC = "ABCDEFGHIJKLMNOPQRST"; // length 20; [10,15] === "KLMNO"

describe("cm6 review offset remapping", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("seeds thread ranges into the comment field", () => {
    const { view } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    expect(getCurrentRanges(view)).toEqual([
      { id: "t1", from: 10, to: 15, status: "open" },
    ]);
    view.destroy();
  });

  it("shifts a thread right when text is inserted before it", () => {
    const { view } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    view.dispatch({ changes: { from: 0, insert: "12345" } });
    expect(getCurrentRanges(view)).toEqual([
      { id: "t1", from: 15, to: 20, status: "open" },
    ]);
    view.destroy();
  });

  it("leaves a thread in place when text is inserted after it", () => {
    const { view } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    view.dispatch({ changes: { from: 18, insert: "ZZ" } });
    expect(getCurrentRanges(view)).toEqual([
      { id: "t1", from: 10, to: 15, status: "open" },
    ]);
    view.destroy();
  });

  it("remaps multiple threads independently", () => {
    const { view } = makeView(DOC);
    dispatchSetThreads(view, [
      { id: "a", from: 2, to: 5, status: "open" },
      { id: "b", from: 12, to: 16, status: "resolved" },
    ]);
    // Insert between the two anchors: only the later one shifts.
    view.dispatch({ changes: { from: 8, insert: "XXX" } });
    const ranges = getCurrentRanges(view);
    expect(ranges).toContainEqual({ id: "a", from: 2, to: 5, status: "open" });
    expect(ranges).toContainEqual({
      id: "b",
      from: 15,
      to: 19,
      status: "resolved",
    });
    view.destroy();
  });

  it("drops a thread whose entire anchor is deleted", () => {
    const { view } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    // Delete a region that fully covers [10,15].
    view.dispatch({ changes: { from: 8, to: 17, insert: "" } });
    expect(getCurrentRanges(view)).toEqual([]);
    view.destroy();
  });
});

describe("cm6 persistenceBridge debounce + flush", () => {
  afterEach(() => {
    document.body.innerHTML = "";
    vi.useRealTimers();
  });

  it("debounces offset persistence and fires after the quiet window", () => {
    vi.useFakeTimers();
    const { view, offsetCalls } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    view.dispatch({ changes: { from: 0, insert: "12345" } });

    expect(offsetCalls).toHaveLength(0);
    vi.advanceTimersByTime(2_000);
    expect(offsetCalls).toHaveLength(1);
    expect(offsetCalls[0]).toEqual([
      { id: "t1", from: 15, to: 20, anchorText: "KLMNO" },
    ]);
    view.destroy();
  });

  it("resets the debounce on each edit so only the final remap persists", () => {
    vi.useFakeTimers();
    const { view, offsetCalls } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);

    view.dispatch({ changes: { from: 0, insert: "12" } });
    vi.advanceTimersByTime(1_000);
    view.dispatch({ changes: { from: 0, insert: "34" } });
    vi.advanceTimersByTime(1_000);
    expect(offsetCalls).toHaveLength(0);

    vi.advanceTimersByTime(2_000);
    expect(offsetCalls).toHaveLength(1);
    // Two 2-char inserts before the anchor: [10,15] -> [14,19].
    expect(offsetCalls[0]).toEqual([
      { id: "t1", from: 14, to: 19, anchorText: "KLMNO" },
    ]);
    view.destroy();
  });

  it("destroy() flushes a pending remap instead of dropping it", () => {
    vi.useFakeTimers();
    const { view, offsetCalls } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    view.dispatch({ changes: { from: 0, insert: "12345" } });

    // Tab switch remounts the editor before the 2s debounce elapses.
    expect(offsetCalls).toHaveLength(0);
    view.destroy();

    expect(offsetCalls).toHaveLength(1);
    expect(offsetCalls[0]).toEqual([
      { id: "t1", from: 15, to: 20, anchorText: "KLMNO" },
    ]);
    // The flushed timer must not fire again after teardown.
    vi.advanceTimersByTime(2_000);
    expect(offsetCalls).toHaveLength(1);
  });

  it("destroy() with no pending edit does not persist", () => {
    vi.useFakeTimers();
    const { view, offsetCalls } = makeView(DOC);
    dispatchSetThreads(view, [{ id: "t1", from: 10, to: 15, status: "open" }]);
    // setThreads is an effect, not a doc change — no debounce armed.
    view.destroy();
    expect(offsetCalls).toHaveLength(0);
  });
});
