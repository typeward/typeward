import {
  Bookmark,
  Calendar,
  FileText,
  Quote,
  Sparkles,
  StickyNote,
  Timer,
  TrendingUp,
} from "lucide-solid";
import type { Component } from "solid-js";
import { createSignal } from "solid-js";
import { registerWidget } from "./registry";

/**
 * Widget catalog. Compose + Activity used to live here as small widget
 * cards but were promoted back to the full-width ComposerHero panel above
 * the toolbar (2026-05-15). Everything left in the registry is an optional
 * extra widget, all disabled by default; users opt in via the Widgets
 * dropdown above the project grid.
 *
 * Stubs are intentional — see /design/widgets.md.
 */

// ---------- Pinned notes (functional, in-memory until a backing store lands) ----------

const [pinnedNote, setPinnedNote] = createSignal("");

const PinnedNotesWidget: Component = () => (
  <textarea
    value={pinnedNote()}
    onInput={(e) => setPinnedNote(e.currentTarget.value)}
    placeholder="Scratch notes, ideas, todo, anything sticky…"
    class="glass-inset h-full w-full resize-none rounded-lg p-2.5 text-[length:var(--ui-font-sm)] text-fg-1 placeholder:text-fg-4 focus:outline-none"
  />
);

registerWidget({
  id: "pinned-notes",
  title: "Pinned notes",
  description: "A scratchpad that persists across sessions",
  defaultEnabled: false,
  icon: (size = 14) => <StickyNote size={size} />,
  Render: PinnedNotesWidget,
  order: 30,
});

// ---------- Focus timer (stub) ----------

registerWidget({
  id: "focus-timer",
  title: "Focus timer",
  description: "Pomodoro — 25 / 5 / 15",
  defaultEnabled: false,
  icon: (size = 14) => <Timer size={size} />,
  Render: () => <StubBody label="Pomodoro timer" />,
  order: 40,
  stub: true,
});

// ---------- Word count goal (stub) ----------

registerWidget({
  id: "word-goal",
  title: "Word count goal",
  description: "Daily / weekly writing target",
  defaultEnabled: false,
  icon: (size = 14) => <TrendingUp size={size} />,
  Render: () => <StubBody label="Word count progress" />,
  order: 50,
  stub: true,
});

// ---------- Snippets (stub) ----------

registerWidget({
  id: "snippets",
  title: "Snippets",
  description: "LaTeX / Typst / Markdown clipboard",
  defaultEnabled: false,
  icon: (size = 14) => <FileText size={size} />,
  Render: () => <StubBody label="Snippets library" />,
  order: 60,
  stub: true,
});

// ---------- Calendar (stub) ----------

registerWidget({
  id: "calendar",
  title: "Calendar",
  description: "Deadlines + upcoming",
  defaultEnabled: false,
  icon: (size = 14) => <Calendar size={size} />,
  Render: () => <StubBody label="Calendar + deadlines" />,
  order: 70,
  stub: true,
});

// ---------- AI suggest (stub) ----------

registerWidget({
  id: "ai-suggest",
  title: "AI suggest",
  description: "Prompt-driven project ideas",
  defaultEnabled: false,
  icon: (size = 14) => <Sparkles size={size} />,
  Render: () => <StubBody label="AI project suggestions" />,
  order: 80,
  stub: true,
});

// ---------- References queue (stub) ----------

registerWidget({
  id: "refs",
  title: "References queue",
  description: "Papers / URLs to read later",
  defaultEnabled: false,
  icon: (size = 14) => <Quote size={size} />,
  Render: () => <StubBody label="References to read" />,
  order: 90,
  stub: true,
});

// ---------- Bookmarks (stub) ----------

registerWidget({
  id: "bookmarks",
  title: "Bookmarks",
  description: "Pinned files across projects",
  defaultEnabled: false,
  icon: (size = 14) => <Bookmark size={size} />,
  Render: () => <StubBody label="Pinned files" />,
  order: 100,
  stub: true,
});

const StubBody: Component<{ label: string }> = (props) => (
  <div class="flex h-full flex-col items-center justify-center gap-1.5 text-center">
    <span
      class="label-xs"
      style={{ color: "var(--color-accent-1)", opacity: 0.7 }}
    >
      coming soon
    </span>
    <span class="text-[length:var(--ui-font-sm)] text-fg-2">{props.label}</span>
    <span class="mono mt-1 text-[10px] text-fg-4">stub · register for updates</span>
  </div>
);
