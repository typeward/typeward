import { beforeEach, describe, expect, it } from "vitest";

import type { Project } from "~/adapters/types";
import { toIsoDate } from "~/lib/deadlines";
import { checkDeadlinesOnce } from "~/lib/deadline-watch";
import {
  notifications,
  resetNotificationsForTest,
} from "~/stores/notifications-store";

const NOW = new Date("2026-06-15T09:00:00");

/** A deadline `days` out from NOW, as the ISO date the picker would store. */
function inDays(days: number, from: Date = NOW): string {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + days);
  return toIsoDate(d);
}

function project(name: string, over: Partial<Project> = {}): Project {
  return {
    rootPath: `C:/proj/${name}`,
    rootFile: "main.tex",
    format: "latex",
    name,
    ...over,
  };
}

const titles = () => notifications().map((n) => n.title);

describe("deadline reminders", () => {
  beforeEach(() => {
    localStorage.clear();
    resetNotificationsForTest();
  });

  it("stays quiet for deadlines further out than a week", () => {
    checkDeadlinesOnce([project("thesis", { deadline: inDays(8) })], NOW);
    expect(notifications()).toHaveLength(0);
  });

  it("ignores projects with no deadline set", () => {
    checkDeadlinesOnce([project("thesis")], NOW);
    expect(notifications()).toHaveLength(0);
  });

  it("files one reminder per escalation step, tightest first", () => {
    for (const [days, kind] of [
      [7, "info"],
      [3, "warn"],
      [1, "warn"],
      [0, "err"],
      [-2, "err"],
    ] as const) {
      resetNotificationsForTest();
      checkDeadlinesOnce([project("thesis", { deadline: inDays(days) })], NOW);
      expect(notifications(), `days=${days}`).toHaveLength(1);
      expect(notifications()[0]!.kind, `days=${days}`).toBe(kind);
    }
  });

  it("names the project and how long is left", () => {
    checkDeadlinesOnce([project("thesis", { deadline: inDays(0) })], NOW);
    expect(titles()).toEqual(['"thesis" is due today']);

    resetNotificationsForTest();
    checkDeadlinesOnce([project("thesis", { deadline: inDays(-3) })], NOW);
    expect(titles()).toEqual(['"thesis" is past its deadline']);
  });

  it("does not repeat a step it has already reported", () => {
    const list = [project("thesis", { deadline: inDays(3) })];
    checkDeadlinesOnce(list, NOW);
    checkDeadlinesOnce(list, NOW);
    checkDeadlinesOnce(list, NOW);
    expect(notifications()).toHaveLength(1);
  });

  it("reports the next step as the deadline closes in", () => {
    const list = [project("thesis", { deadline: inDays(3) })];
    checkDeadlinesOnce(list, NOW);

    // Two days on, the same deadline is now "tomorrow": a new step, so one
    // more reminder, and still only one for that step.
    const later = new Date(NOW);
    later.setDate(later.getDate() + 2);
    checkDeadlinesOnce(list, later);
    checkDeadlinesOnce(list, later);

    expect(titles()).toEqual([
      '"thesis" is due tomorrow',
      '"thesis" is due in 3 days',
    ]);
  });

  it("re-arms a step when the deadline is moved to a new date", () => {
    checkDeadlinesOnce([project("thesis", { deadline: inDays(1) })], NOW);
    expect(notifications()).toHaveLength(1);

    // Pushed back a week, then viewed a week later: "tomorrow" again, but a
    // different date, so it is news rather than a suppressed repeat.
    const rescheduled = [project("thesis", { deadline: inDays(8) })];
    const later = new Date(NOW);
    later.setDate(later.getDate() + 7);
    checkDeadlinesOnce(rescheduled, later);

    expect(titles()).toEqual([
      '"thesis" is due tomorrow',
      '"thesis" is due tomorrow',
    ]);
  });

  it("ignores trashed and archived projects", () => {
    checkDeadlinesOnce(
      [
        project("trashed", { deadline: inDays(0), trashedAt: Date.now() }),
        project("archived", { deadline: inDays(0), archived: true }),
        project("live", { deadline: inDays(0) }),
      ],
      NOW,
    );
    expect(titles()).toEqual(['"live" is due today']);
  });

  it("reminds per project, not once globally", () => {
    checkDeadlinesOnce(
      [
        project("thesis", { deadline: inDays(0) }),
        project("paper", { deadline: inDays(0) }),
      ],
      NOW,
    );
    expect(notifications()).toHaveLength(2);
  });
});
