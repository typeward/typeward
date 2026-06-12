import {
  FolderOpen,
  Pause,
  Play,
  RotateCcw,
  StickyNote,
  Timer,
} from "lucide-solid";
import type { Component } from "solid-js";
import { For, Show, createSignal, onCleanup } from "solid-js";
import { navigateTo } from "~/commands/palette-store";
import { projects } from "~/stores/projects-store";
import { registerWidget } from "./registry";

/**
 * Dashboard card catalog. Cards render inside the Projects screen's opt-in
 * dashboard panel (`DashboardPanel.tsx`) next to the fixed Activity card;
 * each is individually toggleable from the panel's Customize menu and
 * drag-reorderable. Only cards that actually work get registered — the old
 * stub roster taught users the surface was decorative.
 */

// ---------- Recent projects ----------

const RecentProjectsWidget: Component = () => (
  <div class="flex h-full flex-col gap-1 overflow-auto scroll">
    <Show
      when={projects().length > 0}
      fallback={
        <div class="flex h-full items-center justify-center text-[length:var(--ui-font-xs)] text-fg-3">
          No projects yet.
        </div>
      }
    >
      <For each={projects().slice(0, 5)}>
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
            <span class="mono ml-auto flex-shrink-0 text-[10px] uppercase text-fg-4">
              {p.format}
            </span>
          </button>
        )}
      </For>
    </Show>
  </div>
);

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
    class="glass-inset h-full w-full resize-none rounded-lg p-2.5 text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-3 focus:outline-none"
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

// ---------- Focus timer ----------

// Module-scope so the countdown survives shelf remounts and screen
// navigation; only the interval lives per-component.
type TimerPhase = "focus" | "break" | "long";
const PHASE_MINUTES: Record<TimerPhase, number> = { focus: 25, break: 5, long: 15 };
const [timerPhase, setTimerPhase] = createSignal<TimerPhase>("focus");
const [secondsLeft, setSecondsLeft] = createSignal(PHASE_MINUTES.focus * 60);
const [running, setRunning] = createSignal(false);

const FocusTimerWidget: Component = () => {
  const interval = setInterval(() => {
    if (!running()) return;
    setSecondsLeft((s) => {
      if (s > 1) return s - 1;
      setRunning(false);
      return 0;
    });
  }, 1000);
  onCleanup(() => clearInterval(interval));

  const display = () => {
    const s = secondsLeft();
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  };
  const selectPhase = (phase: TimerPhase) => {
    setTimerPhase(phase);
    setRunning(false);
    setSecondsLeft(PHASE_MINUTES[phase] * 60);
  };

  return (
    <div class="flex h-full flex-col items-center justify-center gap-2">
      <div class="flex gap-1">
        <For each={["focus", "break", "long"] as TimerPhase[]}>
          {(phase) => (
            <button
              type="button"
              onClick={() => selectPhase(phase)}
              class={`mono rounded px-1.5 py-0.5 text-[10px] uppercase ${
                timerPhase() === phase
                  ? "bg-[var(--color-selection-bg)] text-fg-1"
                  : "text-fg-3 hover:bg-[var(--color-control-fill)]"
              }`}
            >
              {PHASE_MINUTES[phase]}m
            </button>
          )}
        </For>
      </div>
      <span class="mono text-[30px] font-semibold tabular-nums tracking-tight text-fg-1">
        {display()}
      </span>
      <div class="flex gap-1.5">
        <button
          type="button"
          onClick={() => setRunning((v) => !v && secondsLeft() > 0)}
          aria-label={running() ? "Pause" : "Start"}
          class="lift flex h-7 w-7 items-center justify-center rounded-full accent-grad"
        >
          <Show when={running()} fallback={<Play size={12} />}>
            <Pause size={12} />
          </Show>
        </button>
        <button
          type="button"
          onClick={() => selectPhase(timerPhase())}
          aria-label="Reset"
          class="lift flex h-7 w-7 items-center justify-center rounded-full text-fg-2 hover:bg-[var(--color-control-fill)]"
        >
          <RotateCcw size={12} />
        </button>
      </div>
    </div>
  );
};

registerWidget({
  id: "focus-timer",
  title: "Focus timer",
  description: "Pomodoro — 25 / 5 / 15",
  defaultEnabled: true,
  icon: (size = 14) => <Timer size={size} />,
  Render: FocusTimerWidget,
  order: 40,
});
