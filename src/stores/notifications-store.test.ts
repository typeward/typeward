import { beforeEach, describe, expect, it, vi } from "vitest";

/** Re-evaluate the module against the current localStorage: an app restart. */
async function reload(): Promise<typeof import("./notifications-store")> {
  vi.resetModules();
  return await import("./notifications-store");
}

import {
  clearNotifications,
  dismissNotification,
  markAllNotificationsRead,
  notifications,
  pushNotification,
  resetNotificationsForTest,
  unreadCount,
} from "./notifications-store";

describe("notifications-store", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNotificationsForTest();
  });

  it("pushes newest-first and counts unread", () => {
    pushNotification({ kind: "info", title: "first" });
    pushNotification({ kind: "err", title: "second" });

    expect(notifications().map((n) => n.title)).toEqual(["second", "first"]);
    expect(unreadCount()).toBe(2);
  });

  it("collapses repeats under the same key instead of stacking", () => {
    pushNotification({ kind: "err", title: "Sync conflict in a.tex", key: "s:/p" });
    markAllNotificationsRead();
    pushNotification({
      kind: "err",
      title: "Sync conflict in a.tex (and 2 more)",
      key: "s:/p",
    });

    expect(notifications()).toHaveLength(1);
    expect(notifications()[0]!.title).toBe("Sync conflict in a.tex (and 2 more)");
    // A fresh occurrence is news again even though the old row had been read.
    expect(unreadCount()).toBe(1);
  });

  it("keeps entries under different keys apart", () => {
    pushNotification({ kind: "err", title: "a", key: "s:/a" });
    pushNotification({ kind: "err", title: "b", key: "s:/b" });
    expect(notifications()).toHaveLength(2);
  });

  it("fires a `once` key a single time", () => {
    pushNotification({ kind: "info", title: "v2 available", key: "u:2", once: true });
    pushNotification({ kind: "info", title: "v2 available", key: "u:2", once: true });
    expect(notifications()).toHaveLength(1);
  });

  it("does not let dismissal re-arm a `once` key", () => {
    pushNotification({ kind: "warn", title: "due today", key: "d:1", once: true });
    dismissNotification(notifications()[0]!.id);
    expect(notifications()).toHaveLength(0);

    pushNotification({ kind: "warn", title: "due today", key: "d:1", once: true });
    expect(notifications()).toHaveLength(0);
  });

  it("survives a reload, `once` ledger included", async () => {
    pushNotification({ kind: "warn", title: "due today", key: "d:1", once: true });
    pushNotification({ kind: "info", title: "plain" });

    const { notifications: reloaded, pushNotification: pushAgain } = await reload();

    expect(reloaded().map((n) => n.title)).toEqual(["plain", "due today"]);
    pushAgain({ kind: "warn", title: "due today", key: "d:1", once: true });
    expect(reloaded()).toHaveLength(2);
  });

  it("ignores corrupt persisted rows rather than throwing", async () => {
    localStorage.setItem(
      "typeward.notifications",
      JSON.stringify([
        { id: "ok", kind: "info", title: "kept", ts: 1 },
        { id: "bad-kind", kind: "nope", title: "dropped", ts: 2 },
        { id: "no-ts", kind: "info", title: "dropped" },
        "not-an-object",
      ]),
    );
    const { notifications: loaded } = await reload();
    expect(loaded().map((n) => n.title)).toEqual(["kept"]);
  });

  it("clears everything on demand", () => {
    pushNotification({ kind: "info", title: "a" });
    pushNotification({ kind: "info", title: "b" });
    clearNotifications();
    expect(notifications()).toHaveLength(0);
    expect(unreadCount()).toBe(0);
  });
});
