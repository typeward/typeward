import { vi } from "vitest";
import type * as IpcModule from "~/ipc";

/**
 * Reusable, typed stub for the `~/ipc` command-wrapper module.
 *
 * Several suites hand-roll their own `vi.mock("~/ipc", ...)` factories with
 * divergent shapes — some stub two wrappers, some four, and an unstubbed
 * wrapper called by the code under test silently returns `undefined` instead of
 * failing loudly. `ipcMock()` gives one shape: every wrapper you don't override
 * throws a descriptive error the moment the code under test calls it, so a test
 * can never accidentally exercise a real (or silently no-op) IPC path.
 *
 * ## How existing suites adopt this
 *
 * `vi.mock` factories are hoisted above imports, so the factory cannot close
 * over a top-level `import { ipcMock }`. Load it inside an async factory and
 * create per-call `vi.fn()`s inline (or via `vi.hoisted` when a test needs to
 * assert on them):
 *
 * ```ts
 * const spies = vi.hoisted(() => ({ writeProjectTextFile: vi.fn() }));
 * vi.mock("~/ipc", async () => {
 *   const { ipcMock } = await import("~/test/ipc-mock");
 *   return ipcMock({
 *     writeProjectTextFile: spies.writeProjectTextFile,
 *     readProjectTextFile: vi.fn(async () => "contents"),
 *   });
 * });
 * ```
 *
 * Overrides are typed against the real module, so an override key that no
 * longer matches an `~/ipc` export (a rename) is a compile error — the same
 * drift the `drift.test.ts` guard catches on the wire-name side.
 */

type Ipc = typeof IpcModule;

/** Partial map of `~/ipc` exports to replace; unlisted ones throw when called. */
export type IpcOverrides = Partial<{ [K in keyof Ipc]: Ipc[K] }>;

export function ipcMock(overrides: IpcOverrides = {}): Ipc {
  const unstubbed = new Map<string, unknown>();

  const handler: ProxyHandler<Record<string, unknown>> = {
    get(target, prop, receiver) {
      // Keep the object from being mistaken for a thenable when vitest awaits
      // the factory result, and advertise ES-module interop.
      if (typeof prop === "symbol") return Reflect.get(target, prop, receiver);
      if (prop === "then") return undefined;
      if (prop === "__esModule") return true;
      if (prop in target) return Reflect.get(target, prop, receiver);

      if (!unstubbed.has(prop)) {
        unstubbed.set(
          prop,
          vi.fn(() => {
            throw new Error(
              `~/ipc.${prop} was called but not stubbed — pass it to ipcMock({ ${prop}: ... })`,
            );
          }),
        );
      }
      return unstubbed.get(prop);
    },
    has() {
      return true;
    },
  };

  return new Proxy({ ...overrides } as Record<string, unknown>, handler) as unknown as Ipc;
}
