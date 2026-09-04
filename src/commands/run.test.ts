import { beforeEach, describe, expect, it, vi } from "vitest";

const { notifyError } = vi.hoisted(() => ({ notifyError: vi.fn() }));
// run.ts imports notifyError from ~/lib/toast (which statically pulls Kobalte);
// mock it so the toast rendering stack stays out of this unit test. errorText
// now comes from the pure ~/lib/errors and needs no mock.
vi.mock("~/lib/toast", () => ({
  notifyError,
}));

import type { EditorCommand } from "~/adapters/types";
import { dispatchCommand } from "./run";

const cmd = (run: () => unknown): EditorCommand =>
  ({ id: "test.cmd", title: "Test", run }) as unknown as EditorCommand;

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("dispatchCommand", () => {
  beforeEach(() => notifyError.mockClear());

  it("toasts when an async run rejects", async () => {
    dispatchCommand(cmd(async () => {
      throw new Error("boom");
    }));
    await flush();
    expect(notifyError).toHaveBeenCalledWith('"Test" failed', "boom");
  });

  it("toasts when a sync run throws", async () => {
    dispatchCommand(cmd(() => {
      throw new Error("sync-boom");
    }));
    await flush();
    expect(notifyError).toHaveBeenCalledWith('"Test" failed', "sync-boom");
  });

  it("stays silent when run resolves", async () => {
    dispatchCommand(cmd(async () => undefined));
    await flush();
    expect(notifyError).not.toHaveBeenCalled();
  });
});
