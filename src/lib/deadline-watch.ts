/**
 * Deadline reminders. Watches the library for projects whose user-set deadline
 * is closing in and files one notification per escalation step.
 *
 * Two triggers, because either alone leaves a gap: the library signal fires on
 * load and on every deadline edit, and an hourly sweep catches a session that
 * is simply left open across midnight (the app can run for days).
 *
 * Every reminder is pushed with `once`, so a project announces each step a
 * single time and a restart does not replay the backlog.
 */

import { createEffect, onCleanup } from "solid-js";

import { deadlineStatus } from "~/lib/deadlines";
import type { Project } from "~/adapters/types";
import { isTrashed, projects } from "~/stores/projects-store";
import { pushNotification } from "~/stores/notifications-store";
import type { NotificationKind } from "~/stores/notifications-store";

const HOUR_MS = 3_600_000;

interface Step {
  /** Stable id: it is part of the dedupe key, so renaming one re-fires it. */
  id: string;
  /** Whole days until the deadline; steps are tested nearest-first. */
  matches: (days: number) => boolean;
  kind: NotificationKind;
}

// Ordered tightest-first so a project that goes straight from "in 9 days" to
// overdue (an app left closed over a week) reports the state it is actually in
// rather than every step it skipped.
const STEPS: readonly Step[] = [
  { id: "overdue", matches: (d) => d < 0, kind: "err" },
  { id: "today", matches: (d) => d === 0, kind: "err" },
  { id: "tomorrow", matches: (d) => d === 1, kind: "warn" },
  { id: "3d", matches: (d) => d <= 3, kind: "warn" },
  { id: "7d", matches: (d) => d <= 7, kind: "info" },
];

/**
 * Takes the library explicitly rather than reading the store, so the escalation
 * rules stay a pure function of (projects, now) and the caller owns the
 * reactive read.
 */
export function checkDeadlinesOnce(
  list: readonly Project[],
  now: Date = new Date(),
): void {
  for (const p of list) {
    // Trashed projects are unopenable and archived ones are deliberately out
    // of sight; neither should nag.
    if (isTrashed(p) || p.archived) continue;

    const status = deadlineStatus(p.deadline, now);
    if (!status) continue;

    const step = STEPS.find((s) => s.matches(status.days));
    if (!step) continue;

    pushNotification({
      kind: step.kind,
      title:
        status.days < 0
          ? `"${p.name}" is past its deadline`
          : `"${p.name}" is due ${status.relative}`,
      body:
        status.days < 0
          ? `The deadline was ${status.label}, ${status.relative}.`
          : `Deadline: ${status.label}.`,
      // The deadline date is in the key so moving the date re-arms every step,
      // which is what a user rescheduling a project expects.
      key: `deadline:${p.rootPath}:${p.deadline}:${step.id}`,
      once: true,
    });
  }
}

/** Wire the watcher at app start. Returns an uninstall for cleanup. */
export function installDeadlineWatch(): () => void {
  createEffect(() => {
    // Reading the signal here is the subscription: an edited or newly loaded
    // deadline re-runs the check.
    checkDeadlinesOnce(projects());
  });

  const timer = setInterval(() => checkDeadlinesOnce(projects()), HOUR_MS);
  const stop = () => clearInterval(timer);
  onCleanup(stop);
  return stop;
}
