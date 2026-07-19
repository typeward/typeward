import { beforeEach, describe, expect, it } from "vitest";
import {
  COMPILE_COMMAND_IDS,
  dispatchMenuCommand,
  MENU_COMMAND_IDS,
  MENU_COMPILE_ID,
  MENU_STOP_COMPILE_ID,
} from "./menu-bridge";
import { LatexAdapter } from "~/adapters/latex/LatexAdapter";
import { TypstAdapter } from "~/adapters/typst/TypstAdapter";
import { bootCoreCommands, registerAdapterCommands } from "~/commands/boot";
import { _resetForTests, getCommand, registerCommand } from "~/commands/registry";

// The menu/registry drift guard: every id lib.rs's install_macos_menu can
// emit must resolve to a registered command (via the two documented aliases
// where noted) — otherwise a renamed or deleted command leaves a dead menu
// item that only a Mac smoke test could catch.
describe("macOS menu / command registry drift", () => {
  beforeEach(() => {
    _resetForTests();
    bootCoreCommands();
    // Adapter commands (compile, forward search) register on project load;
    // one adapter is live at a time, and LaTeX carries the larger command
    // set (latex.syncForward), so it's the drift baseline.
    registerAdapterCommands(LatexAdapter);
  });

  it("every menu item id resolves to a registered command", () => {
    for (const id of MENU_COMMAND_IDS) {
      if (id === MENU_STOP_COMPILE_ID) continue; // bridge-special-cased to cancelActiveCompile()
      if (id === MENU_COMPILE_ID) continue; // per-format alias — covered below
      expect(getCommand(id), `menu item id "${id}" has no registered command`).toBeDefined();
    }
  });

  it("the Compile alias resolves against whichever format adapter is live", () => {
    for (const adapter of [LatexAdapter, TypstAdapter]) {
      _resetForTests();
      bootCoreCommands();
      registerAdapterCommands(adapter);
      const resolved = COMPILE_COMMAND_IDS.some((id) => getCommand(id) !== undefined);
      expect(resolved, `no compile candidate registered for ${adapter.languageId}`).toBe(true);
    }
  });

  it("the stop-compile alias stays bridge-owned (no registry command shadows it)", () => {
    // If a real registry command ever takes this id, the bridge's special
    // case would silently shadow it — fail here so the two get reconciled.
    expect(getCommand(MENU_STOP_COMPILE_ID)).toBeUndefined();
  });

  it("menu dispatch treats gated-off and unknown ids as silent no-ops", () => {
    let ran = 0;
    registerCommand({
      id: "test.gatedOff",
      title: "Gated off",
      when: () => false,
      run: () => {
        ran += 1;
      },
    });
    registerCommand({
      id: "test.gatedOn",
      title: "Gated on",
      when: () => true,
      run: () => {
        ran += 1;
      },
    });
    dispatchMenuCommand("test.gatedOff");
    dispatchMenuCommand("test.notRegistered");
    expect(ran).toBe(0);
    dispatchMenuCommand("test.gatedOn");
    expect(ran).toBe(1);
  });
});
