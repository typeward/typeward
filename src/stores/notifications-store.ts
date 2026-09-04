/**
 * Notification centre: the durable half of user-facing feedback.
 *
 * Toasts (`lib/toast.ts`) are transient, so anything worth finding again after
 * it has flashed past (a sync conflict, a release you have not installed yet, a
 * deadline closing in) is pushed here as well and rendered by
 * `components/projects/NotificationsPanel.tsx`.
 *
 * The bar is "would the user want to come back to this later". A compile
 * failure is deliberately NOT here: the console, the status pill and the log
 * drawer all already report it live, and a build that fails on and off while
 * you edit would bury everything else.
 *
 * Persisted in localStorage rather than settings.json: this is per-machine UI
 * state that churns far more often than settings do, and nothing in Rust reads
 * it. Both stored lists are bounded, so a long-lived install cannot grow them
 * without limit.
 */

import { createSignal } from "solid-js";
import { nanoid } from "nanoid";

export type NotificationKind = "info" | "ok" | "warn" | "err";

export interface Notification {
  id: string;
  kind: NotificationKind;
  title: string;
  body?: string;
  /** Epoch millis. */
  ts: number;
  read?: boolean;
  /** Collapse key, retained so a later push can find and replace this entry. */
  key?: string;
}

export interface NotificationInput {
  kind: NotificationKind;
  title: string;
  body?: string;
  /**
   * Collapse key. A repeat under the same key replaces the existing entry and
   * re-marks it unread, so a recurring event (the same project conflicting on
   * every sync pass) refreshes one row instead of filling the drawer with
   * identical ones.
   */
  key?: string;
  /**
   * Fire at most once for this key, ever. The key is remembered separately from
   * the list, so dismissing the row (or restarting the app) does not let it
   * fire again. Deadline reminders need this; without it every launch would
   * re-announce the same deadline. Ignored unless `key` is set.
   */
  once?: boolean;
}

const ITEMS_KEY = "typeward.notifications";
const SEEN_KEY = "typeward.notifications-seen";
const MAX_ITEMS = 50;
// `once` keys are never cleared by dismissal, so they would otherwise
// accumulate one per project per deadline per bucket forever.
const MAX_SEEN = 300;

const KINDS: readonly string[] = ["info", "ok", "warn", "err"];

function readJson(key: string): unknown {
  try {
    const raw = localStorage.getItem(key);
    return raw === null ? null : JSON.parse(raw);
  } catch {
    // Unparseable, or localStorage unavailable (the preview window runs in a
    // context where it can throw). Absent history is never worth failing over.
    return null;
  }
}

function writeJson(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or a storage-less context: keep the in-memory list working */
  }
}

/** Persisted rows are user-editable text on disk, so re-validate every field. */
function coerceNotification(raw: unknown): Notification | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.id !== "string" || typeof r.title !== "string") return null;
  if (typeof r.kind !== "string" || !KINDS.includes(r.kind)) return null;
  if (typeof r.ts !== "number" || !Number.isFinite(r.ts)) return null;
  return {
    id: r.id,
    kind: r.kind as NotificationKind,
    title: r.title,
    body: typeof r.body === "string" ? r.body : undefined,
    ts: r.ts,
    read: r.read === true,
    key: typeof r.key === "string" ? r.key : undefined,
  };
}

function loadItems(): Notification[] {
  const parsed = readJson(ITEMS_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .map(coerceNotification)
    .filter((n): n is Notification => n !== null)
    .slice(0, MAX_ITEMS);
}

function loadSeen(): string[] {
  const parsed = readJson(SEEN_KEY);
  if (!Array.isArray(parsed)) return [];
  return parsed
    .filter((v): v is string => typeof v === "string")
    .slice(0, MAX_SEEN);
}

// Newest first: the drawer renders in list order and the panel has no sort.
const [notifications, setNotifications] = createSignal<Notification[]>(loadItems());
let seenKeys: string[] = loadSeen();

function persist(next: Notification[]): void {
  writeJson(ITEMS_KEY, next);
}

export const unreadCount = (): number =>
  notifications().filter((n) => !n.read).length;

/**
 * Record a durable notification. Call this alongside (not instead of) the toast
 * for events the user may want to find again later; a toast that is purely
 * about the action they just took does not belong here.
 */
export function pushNotification(input: NotificationInput): void {
  if (input.key && input.once) {
    if (seenKeys.includes(input.key)) return;
    seenKeys = [input.key, ...seenKeys].slice(0, MAX_SEEN);
    writeJson(SEEN_KEY, seenKeys);
  }

  const entry: Notification = {
    id: nanoid(8),
    kind: input.kind,
    title: input.title,
    body: input.body,
    ts: Date.now(),
    read: false,
    key: input.key,
  };

  setNotifications((prev) => {
    const rest = input.key ? prev.filter((n) => n.key !== input.key) : prev;
    const next = [entry, ...rest].slice(0, MAX_ITEMS);
    persist(next);
    return next;
  });
}

export function dismissNotification(id: string): void {
  setNotifications((prev) => {
    const next = prev.filter((n) => n.id !== id);
    persist(next);
    return next;
  });
}

export function markAllNotificationsRead(): void {
  setNotifications((prev) => {
    const next = prev.map((n) => (n.read ? n : { ...n, read: true }));
    persist(next);
    return next;
  });
}

export function clearNotifications(): void {
  setNotifications(() => {
    persist([]);
    return [];
  });
}

// Shared open state: the drawer mounts once at the App root and every screen's
// bell drives this same signal, so notifications are reachable from Projects,
// Settings and the editor alike.
const [notifOpen, setNotifOpen] = createSignal(false);

export const toggleNotifications = (): void => {
  setNotifOpen((v) => !v);
};
export const openNotifications = (): void => {
  setNotifOpen(true);
};
export const closeNotifications = (): void => {
  setNotifOpen(false);
};

export { notifications, notifOpen };

/** Test seam: drop every persisted trace, including the `once` ledger. */
export function resetNotificationsForTest(): void {
  seenKeys = [];
  writeJson(SEEN_KEY, []);
  setNotifications(() => {
    persist([]);
    return [];
  });
}
