import { beforeEach, describe, expect, it } from "vitest";
import { bootCoreCommands, registerAdapterCommands, unregisterAdapterCommands } from "./boot";
import { requestProDialog_, setRequestProDialog } from "./palette-store";
import { _resetForTests, commands, getCommand } from "./registry";
import type { EditorAdapter, Project } from "~/adapters/types";
import { PRO_DISCOVERY_ENABLED } from "~/config/pro";
import {
  resetEntitlementSource,
  setEntitlementSource,
} from "~/integrations/entitlements";
import { openFile, resetTabs, setProject } from "~/stores/editor-store";

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

  it("core.save is a save+compile command gated only on an active file (no dirty gate)", () => {
    bootCoreCommands();
    const save = getCommand("core.save");
    expect(save?.title).toBe("Save and compile");
    expect(save?.scope).toBe("editor");

    setProject({ rootPath: "/A", rootFile: "main.tex", format: "latex", name: "A" } as Project);
    resetTabs();
    expect(save?.when?.()).toBe(false); // no active file

    // A CLEAN active file must still enable the command (old behavior gated on dirty).
    openFile({ path: "/A/main.tex", relPath: "main.tex", content: "x", dirty: false });
    expect(save?.when?.()).toBe(true);

    resetTabs();
    setProject(null);
  });

  it("core.whatsInPro follows the Pro-discovery flag and raises the ProDialog request", () => {
    bootCoreCommands();
    const cmd = getCommand("core.whatsInPro");
    expect(cmd).toBeDefined();
    // The `when` gate rides the free-only-beta flag, never the tier — while
    // discovery is off the entry hides for everyone, once it's on it must
    // not vanish per tier.
    expect(cmd?.when?.()).toBe(PRO_DISCOVERY_ENABLED);

    setRequestProDialog(false);
    void cmd?.run();
    expect(requestProDialog_()).toBe(true);
    setRequestProDialog(false);
  });

  it("core.saveTemplate hides on the free tier (custom templates are Pro)", () => {
    bootCoreCommands();
    const cmd = getCommand("core.saveTemplate");
    setProject({ rootPath: "/A", rootFile: "main.tex", format: "latex", name: "A" } as Project);

    expect(cmd?.when?.()).toBe(false);

    setEntitlementSource({
      current: () => "pro",
      has: () => true,
      reasonIfMissing: () => undefined,
    });
    expect(cmd?.when?.()).toBe(true);

    resetEntitlementSource();
    setProject(null);
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
