import { describe, expect, it } from "vitest";
import {
  __setViewportWidthForTest,
  activePane,
  cyclePane,
  isTabletViewport,
  logsSheetOpen,
  setActivePane,
  setLogsSheetOpen,
  toggleLogsSheet,
  viewportMode,
} from "./viewport-store";

describe("viewport-store", () => {
  it("classifies desktop vs tablet by the 1024px breakpoint", () => {
    __setViewportWidthForTest(1440);
    expect(viewportMode()).toBe("desktop");
    expect(isTabletViewport()).toBe(false);

    __setViewportWidthForTest(1023);
    expect(viewportMode()).toBe("tablet");
    expect(isTabletViewport()).toBe(true);

    __setViewportWidthForTest(1024);
    expect(viewportMode()).toBe("desktop");
  });

  it("cycles active pane in both directions clamping at ends", () => {
    setActivePane("sidebar");
    cyclePane(1);
    expect(activePane()).toBe("editor");
    cyclePane(1);
    expect(activePane()).toBe("preview");
    // Clamped: a forward swipe at the last pane stays put instead of
    // wrapping back to the sidebar.
    cyclePane(1);
    expect(activePane()).toBe("preview");
    cyclePane(-1);
    expect(activePane()).toBe("editor");
    cyclePane(-1);
    expect(activePane()).toBe("sidebar");
    cyclePane(-1);
    expect(activePane()).toBe("sidebar");
  });

  it("toggles the logs sheet", () => {
    setLogsSheetOpen(false);
    toggleLogsSheet();
    expect(logsSheetOpen()).toBe(true);
    toggleLogsSheet();
    expect(logsSheetOpen()).toBe(false);
  });
});
