/**
 * Project-deadline helpers shared by the Projects screen card chrome and the
 * dashboard cards (stats / calendar). Deadlines are plain ISO dates
 * (`YYYY-MM-DD`) with no time component; everything here is computed in local
 * time against midnight today.
 */

export type DeadlineTone = "overdue" | "soon" | "normal";

export interface DeadlineStatus {
  date: Date;
  /** Whole days from today (negative = past, 0 = today). */
  days: number;
  tone: DeadlineTone;
  /** Short absolute label, e.g. "Mar 5" (year shown only when not this year). */
  label: string;
  /** Relative phrase, e.g. "in 3 days", "today", "2 days ago". */
  relative: string;
}

const MS_PER_DAY = 86_400_000;

export function parseDeadline(deadline?: string | null): Date | null {
  if (!deadline) return null;
  // Anchor at local midnight so day math doesn't drift across timezones.
  const d = new Date(`${deadline}T00:00:00`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function deadlineStatus(
  deadline?: string | null,
  now: Date = new Date(),
): DeadlineStatus | null {
  const date = parseDeadline(deadline);
  if (!date) return null;

  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const days = Math.round((date.getTime() - today.getTime()) / MS_PER_DAY);
  const tone: DeadlineTone = days < 0 ? "overdue" : days <= 7 ? "soon" : "normal";

  const sameYear = date.getFullYear() === today.getFullYear();
  const label = date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    ...(sameYear ? {} : { year: "numeric" }),
  });

  const relative =
    days === 0
      ? "today"
      : days === 1
        ? "tomorrow"
        : days === -1
          ? "yesterday"
          : days > 0
            ? `in ${days} days`
            : `${-days} days ago`;

  return { date, days, tone, label, relative };
}

export const DEADLINE_TONE_COLOR: Record<DeadlineTone, string> = {
  overdue: "var(--color-err)",
  soon: "var(--color-warn)",
  normal: "var(--color-fg-3)",
};

/** Local `YYYY-MM-DD` for a date (matches the value an `<input type=date>` emits). */
export function toIsoDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}
