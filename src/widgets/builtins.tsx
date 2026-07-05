import {
  ArrowRight,
  BarChart3,
  CalendarDays,
  Check,
  ChevronLeft,
  ChevronRight,
  FolderOpen,
  Grid3x3,
  LayoutDashboard,
  Settings2,
  Sigma,
  StickyNote,
} from "lucide-solid";
import type { Component, JSX } from "solid-js";
import { For, Show, createMemo, createSignal } from "solid-js";
import type { Project } from "~/adapters/types";
import { navigateTo } from "~/commands/palette-store";
import {
  DEADLINE_TONE_COLOR,
  deadlineStatus,
  toIsoDate,
} from "~/lib/deadlines";
import { installDismiss } from "~/lib/dismiss";
import { isTrashed, projects } from "~/stores/projects-store";
import { setStatsCards, statsCards } from "~/stores/workspace-store";
import { registerWidget } from "./registry";

/**
 * Widgets-panel card catalog. Cards render inside the Projects screen's opt-in
 * Widgets panel (`DashboardPanel.tsx`); each is individually toggleable from
 * the panel's Customize menu and drag-reorderable. Only cards that actually
 * work get registered — the old stub roster taught users the surface was
 * decorative.
 */

// ---------- Overview ----------

const OverviewWidget: Component = () => {
  const byFormat = () => {
    const counts = new Map<string, number>();
    for (const p of projects()) {
      counts.set(p.format, (counts.get(p.format) ?? 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]);
  };
  // The Rust listing's insertion order is the closest thing to "recent" until
  // per-project opened-at metadata lands; same assumption as Recent projects.
  const latest = () => projects()[0];

  return (
    <div class="flex h-full flex-col justify-center gap-2.5 px-1">
      <div class="flex items-baseline gap-2">
        <span class="text-[28px] font-semibold tracking-tight text-fg-1">
          {projects().length}
        </span>
        <span class="mono text-[length:var(--ui-font-xs)] text-fg-3">
          project{projects().length === 1 ? "" : "s"} in your library
        </span>
      </div>
      <div class="flex flex-wrap gap-1.5">
        <For each={byFormat()}>
          {([format, count]) => (
            <span
              class="mono rounded-full px-2 py-0.5 text-[10px] uppercase text-fg-2"
              style={{ background: "var(--color-control-fill)" }}
            >
              {format} · {count}
            </span>
          )}
        </For>
      </div>
      <Show when={latest()}>
        <button
          type="button"
          onClick={() =>
            navigateTo(`/editor?path=${encodeURIComponent(latest()!.rootPath)}`)
          }
          class="lift glass-inset flex items-center gap-2 rounded-md px-2.5 py-1.5 text-left hover:bg-[var(--color-control-fill)]"
        >
          <span class="text-[length:var(--ui-font-xs)] text-fg-3">Continue</span>
          <span class="truncate text-[length:var(--ui-font-sm)] font-medium text-fg-1">
            {latest()!.name}
          </span>
          <ArrowRight size={11} class="ml-auto flex-shrink-0 text-fg-3" />
        </button>
      </Show>
    </div>
  );
};

registerWidget({
  id: "overview",
  title: "Overview",
  description: "Library size, format breakdown, and a jump back in",
  defaultEnabled: true,
  icon: (size = 14) => <LayoutDashboard size={size} />,
  Render: OverviewWidget,
  order: 5,
});

// ---------- Recent projects ----------

const RecentProjectsWidget: Component = () => {
  const recent = () => projects().filter((p) => !isTrashed(p));
  return (
  <div class="flex h-full flex-col gap-1 overflow-auto scroll">
    <Show
      when={recent().length > 0}
      fallback={
        <div class="flex h-full items-center justify-center text-[length:var(--ui-font-xs)] text-fg-3">
          No projects yet.
        </div>
      }
    >
      <For each={recent().slice(0, 5)}>
        {(p) => (
          <button
            type="button"
            onClick={() => navigateTo(`/editor?path=${encodeURIComponent(p.rootPath)}`)}
            class="lift flex items-center gap-2 rounded-md px-2 py-1.5 text-left hover:bg-[var(--color-control-fill)]"
          >
            <FolderOpen size={11} class="flex-shrink-0 text-fg-3" />
            <span class="truncate text-[length:var(--ui-font-sm)] text-fg-1">
              {p.name}
            </span>
            <span class="mono ml-auto flex-shrink-0 text-[10px] uppercase text-fg-3">
              {p.format}
            </span>
          </button>
        )}
      </For>
    </Show>
  </div>
  );
};

registerWidget({
  id: "recent-projects",
  title: "Recent projects",
  description: "Jump straight back into a project",
  defaultEnabled: true,
  icon: (size = 14) => <FolderOpen size={size} />,
  Render: RecentProjectsWidget,
  order: 10,
});

// The old "Library summary" widget folded into the dashboard's fixed
// Activity card (project count + format breakdown live there now).

// ---------- Pinned notes ----------

// localStorage (not the keyring/settings.json) — it's a scratchpad, not a
// secret, and not worth a Rust settings-schema field.
const NOTE_STORAGE_KEY = "typeward.pinned-note";

const readStoredNote = (): string => {
  try {
    return localStorage.getItem(NOTE_STORAGE_KEY) ?? "";
  } catch {
    return "";
  }
};

const [pinnedNote, setPinnedNote] = createSignal(readStoredNote());

const updateNote = (value: string): void => {
  setPinnedNote(value);
  try {
    if (value) localStorage.setItem(NOTE_STORAGE_KEY, value);
    else localStorage.removeItem(NOTE_STORAGE_KEY);
  } catch {
    // Storage unavailable — keep the in-memory value for the session.
  }
};

const PinnedNotesWidget: Component = () => (
  <textarea
    value={pinnedNote()}
    onInput={(e) => updateNote(e.currentTarget.value)}
    placeholder="Scratch notes, ideas, todo, anything sticky…"
    class="glass-inset h-full w-full resize-none rounded-lg p-2.5 text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-3 outline-none focus-visible:ring-1 focus-visible:ring-[var(--color-accent-1)]"
  />
);

registerWidget({
  id: "pinned-notes",
  title: "Pinned notes",
  description: "A scratchpad that persists across sessions",
  defaultEnabled: true,
  icon: (size = 14) => <StickyNote size={size} />,
  Render: PinnedNotesWidget,
  order: 30,
});

// ---------- Library statistics ----------

const DAY_MS = 86_400_000;

interface StatDef {
  id: string;
  label: string;
  hint: string;
  compute: (ps: Project[], now: Date) => number;
  /** Render the value in the error color when > 0 (e.g. overdue). */
  danger?: boolean;
}

const STAT_CATALOG: StatDef[] = [
  { id: "total", label: "Total", hint: "All projects", compute: (ps) => ps.length },
  {
    id: "latex",
    label: "LaTeX",
    hint: "LaTeX projects",
    compute: (ps) => ps.filter((p) => p.format === "latex").length,
  },
  {
    id: "typst",
    label: "Typst",
    hint: "Typst projects",
    compute: (ps) => ps.filter((p) => p.format === "typst").length,
  },
  {
    id: "deadlines",
    label: "Deadlines",
    hint: "Projects with a deadline set",
    compute: (ps) => ps.filter((p) => p.deadline).length,
  },
  {
    id: "overdue",
    label: "Overdue",
    hint: "Deadlines in the past",
    danger: true,
    compute: (ps, now) =>
      ps.filter((p) => {
        const s = deadlineStatus(p.deadline, now);
        return s != null && s.days < 0;
      }).length,
  },
  {
    id: "dueWeek",
    label: "Due in 7d",
    hint: "Deadlines within the next week",
    compute: (ps, now) =>
      ps.filter((p) => {
        const s = deadlineStatus(p.deadline, now);
        return s != null && s.days >= 0 && s.days <= 7;
      }).length,
  },
  {
    id: "active7",
    label: "Active 7d",
    hint: "Edited in the last 7 days",
    compute: (ps, now) =>
      ps.filter((p) => (p.modifiedAt ?? 0) >= now.getTime() - 7 * DAY_MS).length,
  },
  {
    id: "active30",
    label: "Active 30d",
    hint: "Edited in the last 30 days",
    compute: (ps, now) =>
      ps.filter((p) => (p.modifiedAt ?? 0) >= now.getTime() - 30 * DAY_MS).length,
  },
  {
    id: "newMonth",
    label: "New this mo.",
    hint: "Created this calendar month",
    compute: (ps, now) =>
      ps.filter((p) => {
        if (!p.createdAt) return false;
        const d = new Date(p.createdAt);
        return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth();
      }).length,
  },
  {
    id: "git",
    label: "Git repos",
    hint: "Projects with a git binding",
    compute: (ps) => ps.filter((p) => p.integrations?.git != null).length,
  },
  {
    id: "cloud",
    label: "Cloud-synced",
    hint: "Projects backed by a cloud provider",
    compute: (ps) => ps.filter((p) => p.integrations?.cloudOrigin != null).length,
  },
];

const DEFAULT_STAT_IDS = ["latex", "typst", "deadlines", "overdue"];

/** Coerce a persisted id list to known, de-duped ids (max 4); fall back to the default four. */
function resolveStatIds(ids: string[]): string[] {
  const known = new Set(STAT_CATALOG.map((s) => s.id));
  const out: string[] = [];
  for (const id of ids) {
    if (known.has(id) && !out.includes(id)) out.push(id);
    if (out.length === 4) break;
  }
  return out.length ? out : DEFAULT_STAT_IDS;
}

const StatTile: Component<{ label: string; value: string; tone?: string }> = (
  props,
) => (
  <div
    class="flex flex-col justify-center gap-1 rounded-lg px-3 py-2"
    style={{ background: "var(--color-control-fill)" }}
  >
    <span
      class="text-[24px] font-semibold leading-none tracking-tight"
      style={{ color: props.tone ?? "var(--color-fg-1)" }}
    >
      {props.value}
    </span>
    <span class="mono text-[10px] uppercase tracking-wide text-fg-3">
      {props.label}
    </span>
  </div>
);

const StatPicker: Component = () => {
  const [open, setOpen] = createSignal(false);
  let rootRef: HTMLDivElement | undefined;
  installDismiss(() => rootRef, open, () => setOpen(false));

  const selectedIds = createMemo(() => resolveStatIds(statsCards()));
  const toggle = (id: string) => {
    const cur = selectedIds();
    if (cur.includes(id)) {
      if (cur.length > 1) setStatsCards(cur.filter((x) => x !== id));
    } else if (cur.length < 4) {
      setStatsCards([...cur, id]);
    }
  };

  return (
    <div ref={rootRef} class="relative">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        class="lift flex h-6 items-center gap-1 rounded px-1.5 text-[length:var(--ui-font-xs)] text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
      >
        <Settings2 size={11} />
        <span>Customize</span>
      </button>
      <Show when={open()}>
        <div
          class="glass absolute bottom-full right-0 z-40 mb-1 max-h-[230px] w-[220px] overflow-auto scroll rounded-xl"
          style={{
            padding: "var(--ui-pad-section)",
            background: "var(--color-popover-bg)",
          }}
        >
          <span class="label-xs mb-1.5 block px-1 text-fg-3">
            Pick up to 4 stats
          </span>
          <For each={STAT_CATALOG}>
            {(s) => {
              const on = () => selectedIds().includes(s.id);
              const disabled = () => !on() && selectedIds().length >= 4;
              return (
                <button
                  type="button"
                  disabled={disabled()}
                  onClick={() => toggle(s.id)}
                  class="lift flex w-full items-center gap-2 rounded-md p-1.5 text-left hover:bg-[var(--color-control-fill)] disabled:cursor-default disabled:opacity-40"
                >
                  <span
                    class="flex h-4 w-4 flex-shrink-0 items-center justify-center rounded"
                    style={{
                      background: on()
                        ? "var(--color-accent-1)"
                        : "var(--color-control-fill)",
                      color: "var(--color-accent-fg)",
                    }}
                  >
                    <Show when={on()}>
                      <Check size={11} stroke-width={3} />
                    </Show>
                  </span>
                  <div class="min-w-0 flex-1">
                    <div class="text-[length:var(--ui-font-sm)] text-fg-1">
                      {s.label}
                    </div>
                    <div class="mono truncate text-[10px] text-fg-3">{s.hint}</div>
                  </div>
                </button>
              );
            }}
          </For>
        </div>
      </Show>
    </div>
  );
};

const LibraryStatsWidget: Component = () => {
  const tiles = createMemo(() => {
    const ps = projects();
    const now = new Date();
    return resolveStatIds(statsCards()).map((id) => {
      const def = STAT_CATALOG.find((s) => s.id === id)!;
      return { def, value: def.compute(ps, now) };
    });
  });

  return (
    <div class="flex h-full flex-col gap-2">
      <div class="grid min-h-0 flex-1 grid-cols-2 gap-2">
        <For each={tiles()}>
          {(t) => (
            <StatTile
              label={t.def.label}
              value={t.value.toLocaleString()}
              tone={t.def.danger && t.value > 0 ? "var(--color-err)" : undefined}
            />
          )}
        </For>
      </div>
      <div class="flex justify-end">
        <StatPicker />
      </div>
    </div>
  );
};

registerWidget({
  id: "library-stats",
  title: "Statistics",
  description: "Pick four summary stats — formats, deadlines, activity, and more",
  defaultEnabled: true,
  icon: (size = 14) => <Sigma size={size} />,
  Render: LibraryStatsWidget,
  order: 20,
});

// ---------- Activity graph (heatmap <-> chart) ----------

const ACTIVITY_WEEKS = 17;

// Module-scope so the chosen view survives the card remounting on reorder.
const [activityMode, setActivityMode] = createSignal<"heatmap" | "chart">("heatmap");

interface HeatCell {
  iso: string;
  count: number;
  future: boolean;
}

/** One activity "point" per project on its created day and its modified day. */
function activityByDay(ps: Project[]): Map<string, number> {
  const counts = new Map<string, number>();
  const bump = (ms?: number) => {
    if (!ms) return;
    const iso = toIsoDate(new Date(ms));
    counts.set(iso, (counts.get(iso) ?? 0) + 1);
  };
  for (const p of ps) {
    bump(p.createdAt);
    if (p.modifiedAt && (!p.createdAt || toIsoDate(new Date(p.modifiedAt)) !== toIsoDate(new Date(p.createdAt)))) {
      bump(p.modifiedAt);
    }
  }
  return counts;
}

/** Columns = weeks (oldest→newest), each column = 7 day cells (Sun→Sat). */
function buildHeatmap(counts: Map<string, number>, now: Date): HeatCell[][] {
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const start = new Date(today);
  start.setDate(today.getDate() - today.getDay() - (ACTIVITY_WEEKS - 1) * 7);

  const cols: HeatCell[][] = [];
  const cur = new Date(start);
  for (let w = 0; w < ACTIVITY_WEEKS; w++) {
    const col: HeatCell[] = [];
    for (let d = 0; d < 7; d++) {
      const iso = toIsoDate(cur);
      col.push({ iso, count: counts.get(iso) ?? 0, future: cur.getTime() > today.getTime() });
      cur.setDate(cur.getDate() + 1);
    }
    cols.push(col);
  }
  return cols;
}

function heatColor(count: number, max: number): string {
  if (count <= 0) return "var(--color-control-fill)";
  const ratio = Math.min(1, count / Math.max(1, max));
  const pct = 25 + Math.round(ratio * 60);
  return `color-mix(in oklab, var(--color-accent-1) ${pct}%, transparent)`;
}

const ActivityGraphWidget: Component = () => {
  const grid = createMemo(() => buildHeatmap(activityByDay(projects()), new Date()));
  const maxDay = createMemo(() =>
    Math.max(1, ...grid().flat().map((c) => c.count)),
  );
  const weekly = createMemo(() => grid().map((col) => col.reduce((s, c) => s + c.count, 0)));
  const maxWeek = createMemo(() => Math.max(1, ...weekly()));
  const total = createMemo(() => weekly().reduce((s, v) => s + v, 0));

  // One short month label per column, shown only where the month changes, so
  // both the heatmap and the chart carry date context along the bottom.
  const monthLabels = createMemo(() =>
    grid().map((col, i) => {
      const first = new Date(`${col[0].iso}T00:00:00`);
      const prev = i > 0 ? new Date(`${grid()[i - 1][0].iso}T00:00:00`) : null;
      return !prev || first.getMonth() !== prev.getMonth()
        ? first.toLocaleDateString(undefined, { month: "short" })
        : "";
    }),
  );

  const ToggleButton: Component<{
    mode: "heatmap" | "chart";
    label: string;
    icon: JSX.Element;
  }> = (p) => (
    <button
      type="button"
      onClick={() => setActivityMode(p.mode)}
      aria-label={p.label}
      title={p.label}
      class={`flex h-5 w-5 items-center justify-center rounded ${
        activityMode() === p.mode
          ? "bg-[var(--color-selection-bg)] text-fg-1"
          : "text-fg-3 hover:bg-[var(--color-control-fill)]"
      }`}
    >
      {p.icon}
    </button>
  );

  const MonthLabels: Component = () => (
    <div class="flex w-full gap-[3px]">
      <For each={monthLabels()}>
        {(lbl) => (
          <span class="mono flex-1 overflow-visible whitespace-nowrap text-center text-[8px] leading-none text-fg-3">
            {lbl}
          </span>
        )}
      </For>
    </div>
  );

  // Mon / Wed / Fri ticks aligned to the heatmap's 7 rows (Sun-top).
  const WeekdayCol: Component = () => (
    <div class="flex w-[14px] flex-shrink-0 flex-col gap-[3px]">
      <For each={["", "M", "", "W", "", "F", ""]}>
        {(m) => (
          <span class="mono flex flex-1 items-center justify-end text-[8px] leading-none text-fg-3">
            {m}
          </span>
        )}
      </For>
    </div>
  );

  const Legend: Component = () => (
    <div class="flex items-center gap-1 pl-[18px]">
      <span class="mono text-[8px] text-fg-3">Less</span>
      <For each={[0, 0.25, 0.5, 0.75, 1]}>
        {(r) => (
          <span
            class="h-[8px] w-[8px] rounded-[2px]"
            style={{
              background:
                r === 0
                  ? "var(--color-control-fill)"
                  : `color-mix(in oklab, var(--color-accent-1) ${25 + Math.round(r * 60)}%, transparent)`,
            }}
          />
        )}
      </For>
      <span class="mono text-[8px] text-fg-3">More</span>
    </div>
  );

  return (
    <div class="flex h-full flex-col gap-2">
      <div class="flex items-center justify-between">
        <span class="mono text-[length:var(--ui-font-xs)] text-fg-3">
          {total()} update{total() === 1 ? "" : "s"} · {ACTIVITY_WEEKS} weeks
        </span>
        <div class="glass-soft flex items-center gap-0.5 rounded p-0.5">
          <ToggleButton mode="heatmap" label="Heatmap" icon={<Grid3x3 size={11} />} />
          <ToggleButton mode="chart" label="Chart" icon={<BarChart3 size={11} />} />
        </div>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-1.5">
        <div class="flex min-h-0 flex-1">
          <Show
            when={activityMode() === "heatmap"}
            fallback={
              <div class="flex h-full w-full gap-1">
                <div class="w-[14px] flex-shrink-0" />
                <div class="flex h-full flex-1 items-end gap-[2px]">
                  <For each={weekly()}>
                    {(v) => (
                      <div
                        class="flex-1 rounded-t-[2px]"
                        title={`${v} update${v === 1 ? "" : "s"}`}
                        style={{
                          height: `${v > 0 ? Math.max(8, (v / maxWeek()) * 100) : 4}%`,
                          "min-height": "3px",
                          background:
                            v > 0 ? "var(--color-accent-1)" : "var(--color-control-fill)",
                        }}
                      />
                    )}
                  </For>
                </div>
              </div>
            }
          >
            <div class="flex h-full w-full gap-1">
              <WeekdayCol />
              <div class="flex flex-1 gap-[3px]">
                <For each={grid()}>
                  {(col) => (
                    <div class="flex flex-1 flex-col gap-[3px]">
                      <For each={col}>
                        {(cell) => (
                          <div
                            class="min-h-[6px] flex-1 rounded-[2px]"
                            title={
                              cell.future
                                ? undefined
                                : `${cell.iso}: ${cell.count} update${cell.count === 1 ? "" : "s"}`
                            }
                            style={{
                              background: cell.future
                                ? "transparent"
                                : heatColor(cell.count, maxDay()),
                            }}
                          />
                        )}
                      </For>
                    </div>
                  )}
                </For>
              </div>
            </div>
          </Show>
        </div>

        <div class="flex gap-1">
          <div class="w-[14px] flex-shrink-0" />
          <MonthLabels />
        </div>

        <Show
          when={activityMode() === "heatmap"}
          fallback={
            <div class="mono pl-[18px] text-[8px] text-fg-3">
              {total() > 0 ? `peak ${maxWeek()}/week` : "no activity yet"}
            </div>
          }
        >
          <Legend />
        </Show>
      </div>
    </div>
  );
};

registerWidget({
  id: "activity-graph",
  title: "Activity",
  description: "Contribution heatmap, switchable to a weekly chart",
  defaultEnabled: true,
  icon: (size = 14) => <BarChart3 size={size} />,
  Render: ActivityGraphWidget,
  order: 40,
});

// ---------- Deadlines calendar ----------

const startOfMonth = (d: Date) => new Date(d.getFullYear(), d.getMonth(), 1);

// Module-scope so the viewed month survives the card remounting on reorder.
const [calAnchor, setCalAnchor] = createSignal(startOfMonth(new Date()));
const shiftMonth = (delta: number) =>
  setCalAnchor((a) => new Date(a.getFullYear(), a.getMonth() + delta, 1));

const WEEKDAYS = ["S", "M", "T", "W", "T", "F", "S"];

function monthWeeks(anchor: Date): (Date | null)[][] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const startDay = new Date(year, month, 1).getDay();
  const daysInMonth = new Date(year, month + 1, 0).getDate();
  const cells: (Date | null)[] = [];
  for (let i = 0; i < startDay; i++) cells.push(null);
  for (let d = 1; d <= daysInMonth; d++) cells.push(new Date(year, month, d));
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks: (Date | null)[][] = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return weeks;
}

const DeadlinesWidget: Component = () => {
  const byDate = createMemo(() => {
    const m = new Map<string, Project[]>();
    for (const p of projects()) {
      if (!p.deadline) continue;
      const arr = m.get(p.deadline) ?? [];
      arr.push(p);
      m.set(p.deadline, arr);
    }
    return m;
  });

  // Most urgent deadlines first (overdue sort ahead of upcoming).
  const dueSoon = createMemo(() => {
    const now = new Date();
    return projects()
      .filter((p) => p.deadline)
      .map((p) => ({ p, s: deadlineStatus(p.deadline, now)! }))
      .filter((x) => x.s != null)
      .sort((a, b) => a.s.days - b.s.days)
      .slice(0, 2);
  });

  const todayIso = toIsoDate(new Date());

  return (
    <div class="flex h-full flex-col gap-2">
      <div class="flex items-center justify-between">
        <button
          type="button"
          onClick={() => shiftMonth(-1)}
          aria-label="Previous month"
          class="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
        >
          <ChevronLeft size={13} />
        </button>
        <span class="text-[length:var(--ui-font-sm)] font-medium text-fg-1">
          {calAnchor().toLocaleDateString(undefined, { month: "long", year: "numeric" })}
        </span>
        <button
          type="button"
          onClick={() => shiftMonth(1)}
          aria-label="Next month"
          class="flex h-6 w-6 items-center justify-center rounded text-fg-3 hover:bg-[var(--color-control-fill)] hover:text-fg-1"
        >
          <ChevronRight size={13} />
        </button>
      </div>

      <div class="grid grid-cols-7 gap-[3px] text-center">
        <For each={WEEKDAYS}>
          {(w) => <span class="mono text-[9px] uppercase text-fg-3">{w}</span>}
        </For>
      </div>

      <div class="flex min-h-0 flex-1 flex-col gap-[3px]">
        <For each={monthWeeks(calAnchor())}>
          {(week) => (
            <div class="grid min-h-0 flex-1 grid-cols-7 gap-[3px]">
              <For each={week}>
                {(day) => {
                  if (!day) return <span />;
                  const iso = toIsoDate(day);
                  const hits = () => byDate().get(iso) ?? [];
                  const has = () => hits().length > 0;
                  const isToday = iso === todayIso;
                  return (
                    <button
                      type="button"
                      disabled={!has()}
                      onClick={() => {
                        const first = hits()[0];
                        if (first) navigateTo(`/editor?path=${encodeURIComponent(first.rootPath)}`);
                      }}
                      title={has() ? hits().map((p) => p.name).join(", ") : undefined}
                      class="flex h-full min-h-[16px] w-full items-center justify-center rounded-md text-[10px] disabled:cursor-default"
                      style={{
                        background: has()
                          ? "color-mix(in oklab, var(--color-accent-1) 30%, transparent)"
                          : "transparent",
                        color: has() || isToday ? "var(--color-fg-1)" : "var(--color-fg-3)",
                        "font-weight": has() || isToday ? "600" : "400",
                        "box-shadow": isToday
                          ? "inset 0 0 0 1.5px var(--color-accent-1)"
                          : undefined,
                      }}
                    >
                      {day.getDate()}
                    </button>
                  );
                }}
              </For>
            </div>
          )}
        </For>
      </div>

      <div class="mt-auto flex flex-col gap-1 border-t border-glass-stroke pt-1.5">
        <Show
          when={dueSoon().length > 0}
          fallback={<span class="mono px-0.5 text-[10px] text-fg-3">No deadlines set</span>}
        >
          <For each={dueSoon()}>
            {(x) => (
              <button
                type="button"
                onClick={() =>
                  navigateTo(`/editor?path=${encodeURIComponent(x.p.rootPath)}`)
                }
                class="lift flex items-center gap-1.5 rounded px-0.5 py-0.5 text-left hover:bg-[var(--color-control-fill)]"
              >
                <span
                  class="h-1.5 w-1.5 flex-shrink-0 rounded-full"
                  style={{ background: DEADLINE_TONE_COLOR[x.s.tone] }}
                />
                <span class="flex-1 truncate text-[length:var(--ui-font-xs)] text-fg-1">
                  {x.p.name}
                </span>
                <span
                  class="mono flex-shrink-0 text-[10px]"
                  style={{ color: DEADLINE_TONE_COLOR[x.s.tone] }}
                >
                  {x.s.relative}
                </span>
              </button>
            )}
          </For>
        </Show>
      </div>
    </div>
  );
};

registerWidget({
  id: "deadlines",
  title: "Deadlines",
  description: "Month calendar of deadlines + what's due soon",
  defaultEnabled: true,
  icon: (size = 14) => <CalendarDays size={size} />,
  Render: DeadlinesWidget,
  order: 50,
});
