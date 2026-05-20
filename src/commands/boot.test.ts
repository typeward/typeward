import { beforeEach, describe, expect, it } from "vitest";
import { bootCoreCommands, registerAdapterCommands, unregisterAdapterCommands } from "./boot";
import { _resetForTests, commands, getCommand } from "./registry";
import type { EditorAdapter } from "~/adapters/types";

// bootCoreCommands is idempotent across the entire app lifetime — calling
// it many times must register each command exactly once. We can't reset its
// internal `booted` flag without exposing test plumbing, but we can verify
// the registry contents directly.
const REQUIRED_IDS = [
  "core.togglePalette",
  "core.closePalette",
  "core.newProject",
  "core.openSettings",
  "core.save",
];

describe("bootCoreCommands", () => {
  beforeEach(() => {
    _resetForTests();
  });

  it("registers the expected set of core commands once invoked", () => {
    bootCoreCommands();
    for (const id of REQUIRED_IDS) {
      expect(getCommand(id), `expected ${id} to be registered`).toBeDefined();
    }
  });

  it("does not double-register if called repeatedly", () => {
    bootCoreCommands();
    bootCoreCommands();
    const ids = commands().map((c) => c.id);
    const seen = new Set<string>();
    for (const id of ids) {
      expect(seen.has(id), `duplicate registration of ${id}`).toBe(false);
      seen.add(id);
    }
  });

  it("ships sensible shortcuts on core entries", () => {
    bootCoreCommands();
    expect(getCommand("core.togglePalette")?.shortcut).toBe("Mod+K");
    expect(getCommand("core.newProject")?.shortcut).toBe("Mod+N");
    expect(getCommand("core.save")?.shortcut).toBe("Mod+S");
  });
});

describe("adapter command (un)registration", () => {
  const fakeAdapter: EditorAdapter = {
    languageId: "fake",
    format: "latex",
    previewKind: "pdf",
    cmExtensions: () => [],
    compile: async () => ({
      ok: true,
      diagnostics: [],
      log: "",
      durationMs: 0,
    }),
    commands: [
      {
        id: "fake.runner",
        title: "Fake runner",
        run: () => {},
      },
    ],
  };

  beforeEach(() => {
    _resetForTests();
  });

  it("registers and unregisters the adapter's commands as a unit", () => {
    registerAdapterCommands(fakeAdapter);
    expect(getCommand("fake.runner")).toBeDefined();
    unregisterAdapterCommands(fakeAdapter);
    expect(getCommand("fake.runner")).toBeUndefined();
  });
});
