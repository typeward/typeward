import { beforeEach, describe, expect, it } from "vitest";
import {
  _resetForTests,
  commands,
  getCommand,
  registerCommand,
  unregisterCommand,
} from "./registry";

const noop = () => {};

beforeEach(() => {
  _resetForTests();
});

describe("command registry", () => {
  it("registers and retrieves a command by id", () => {
    registerCommand({ id: "test.a", title: "A", run: noop });
    expect(getCommand("test.a")?.title).toBe("A");
    expect(commands().map((c) => c.id)).toEqual(["test.a"]);
  });

  it("replaces an existing command on re-register (idempotent by id)", () => {
    registerCommand({ id: "test.a", title: "first", run: noop });
    registerCommand({ id: "test.a", title: "second", run: noop });
    expect(getCommand("test.a")?.title).toBe("second");
    expect(commands()).toHaveLength(1);
  });

  it("unregisters a command", () => {
    registerCommand({ id: "test.a", title: "A", run: noop });
    registerCommand({ id: "test.b", title: "B", run: noop });
    unregisterCommand("test.a");
    expect(getCommand("test.a")).toBeUndefined();
    expect(commands().map((c) => c.id)).toEqual(["test.b"]);
  });

  it("ignores unregister of an unknown id without throwing", () => {
    expect(() => unregisterCommand("nope")).not.toThrow();
  });
});
