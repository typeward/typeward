import { describeIpcError } from "~/lib/errors";
import { notifyError, notifyInfo } from "~/lib/toast";
import { createSignal } from "solid-js";
import type { Comment, CommentAuthor, CommentThread } from "~/lib/reviews/types";
import { addReply, resolveThread, reopenThread, threadClock } from "~/lib/reviews/types";
import type { ReviewShard, ThreadPatch } from "~/lib/reviews/shard";
import { buildShard, mergeShards, parseShard } from "~/lib/reviews/shard";
import { hasLocalIdentity, isLocalAuthor, localAuthor } from "~/lib/reviews/identity";
import { project } from "~/stores/editor-store";
import { pushNotification } from "~/stores/notifications-store";
import * as ipc from "~/ipc";
import { recordError } from "~/lib/telemetry";

// Review comments persist to `<project>/.typeward/reviews/<authorId>.json`, one
// shard per install (see `lib/reviews/shard.ts` for why sharding, and for the
// merge rules). This is primary user-authored data, but it lives in the
// non-portable `.typeward/` tree, so it does NOT travel with a copy of the
// project made through Typeward's own cloud sync or git integration, both of
// which exclude `.typeward/`. It DOES travel when the project folder itself is
// synced by a desktop client (OneDrive, Dropbox, Syncthing), which is the case
// sharding exists to serve. See finding #35: a durable relocation is deferred;
// documented here so the trade-off is explicit.
const SIDECAR_DIR = ".typeward/reviews";
const SAVE_DEBOUNCE_MS = 1_500;
/** Quiet gap before a watcher-reported shard change is merged in. */
const RELOAD_DEBOUNCE_MS = 400;
/** Notification rows pushed in one reload, so a bulk sync can't flood the drawer. */
const MAX_ARRIVAL_NOTIFICATIONS = 5;

function shardRelPath(authorId: string): string {
  return `${SIDECAR_DIR}/${authorId}.json`;
}

const [allThreads, setAllThreads] = createSignal<CommentThread[]>([]);
const [showResolved, setShowResolved] = createSignal(false);

// "Open the review panel (optionally targeting a thread)" intent — mirrors the
// requestNewProject/requestSaveTemplate pattern in palette-store. The shell
// observes this, switches to the Review tab, hands the threadId to
// `focusedThreadId`, and clears the intent. The `generation` makes repeated
// clicks on the SAME thread re-fire (new object identity each call).
export interface ReviewPanelIntent {
  threadId?: string;
  // Which sidebar tab to open — comment threads land in "review", TODO-kind
  // threads (e.g. from a PDF selection) in "todo".
  panel: "review" | "todo";
  generation: number;
}
const [reviewPanelIntent, setReviewPanelIntent] =
  createSignal<ReviewPanelIntent | null>(null);
let _reviewIntentGen = 0;

/** Ask the shell to open the review/TODO panel, optionally scrolled to a thread. */
export function requestReviewPanelIntent(
  threadId?: string,
  panel: "review" | "todo" = "review",
): void {
  setReviewPanelIntent({ threadId, panel, generation: ++_reviewIntentGen });
}

/**
 * Compose intent for a new editor-anchored comment/TODO. The add-comment
 * commands raise this instead of creating a thread outright — an empty
 * thread appearing silently in the panel reads as "nothing happened", and
 * the PDF selection path already composes first. The ReviewComposePopover
 * mounted in the editor shell observes and clears it.
 */
export interface ReviewComposeIntent {
  kind: "comment" | "todo";
  /** Selection span + snapshot at the moment the command fired. */
  from: number;
  to: number;
  anchorText: string;
}
const [composeIntent, setComposeIntent] =
  createSignal<ReviewComposeIntent | null>(null);
export const reviewComposeIntent = composeIntent;
export const requestReviewCompose = (intent: ReviewComposeIntent): void => {
  setComposeIntent(intent);
};
export const clearReviewCompose = (): void => {
  setComposeIntent(null);
};

/**
 * Open a thread in the correct panel, routing TODO-kind threads to the TODO
 * tab. Shared by gutter clicks and PDF band clicks, which only know a threadId.
 */
export function requestThreadPanel(threadId: string): void {
  const thread = allThreads().find((t) => t.id === threadId);
  const panel = (thread?.kind ?? "comment") === "todo" ? "todo" : "review";
  requestReviewPanelIntent(threadId, panel);
}

// The thread the ReviewPanel should scroll to + expand. Set by the shell from
// the intent; consumed and cleared by the panel.
const [focusedThreadId, setFocusedThreadId] = createSignal<string | null>(null);
export function clearFocusedThread(): void {
  setFocusedThreadId(null);
}

let _saveTimer: ReturnType<typeof setTimeout> | null = null;
// Root captured when the save was scheduled — the debounce can outlive a
// project switch, and writing to whatever project() points at by then would
// drop one project's threads into another's sidecar.
let _pendingRoot: string | null = null;
// Refuse to persist until a clean load has established what's on disk. A read
// or parse failure that got laundered into an empty writable state would let
// the next save overwrite (and destroy) real threads that merely failed to
// load. Set true on reset, flipped false only by a successful/not-found load.
let _readOnly = true;
// Whether a load has established this project's shards. Separate from
// `_readOnly` because the two answer different questions: a profile with no id
// yet can still read and merge everyone else's comments, it just has no shard
// name of its own to write to.
let _loaded = false;
// This install's edits to threads it does not own (resolve, re-anchor, delete).
// Seeded from our own shard at load and carried into every save; see
// `lib/reviews/shard.ts` for how they resolve against the owner's copy.
let _myPatches: Record<string, ThreadPatch> = {};
// Our shard as it was on disk at load. Only its `replies` are consulted, to
// carry forward comments we wrote on threads whose owner's shard is currently
// unreadable or not yet synced — otherwise rebuilding the shard from a merged
// view that is missing those threads would silently drop our own replies.
let _myShardAtLoad: ReviewShard | null = null;
let _reloadTimer: ReturnType<typeof setTimeout> | null = null;
// One save-failure toast per project — a repeatedly failing debounce must not
// spam the user, but the failure must not be silent either.
let _writeErrorToastedRoot: string | null = null;
// Bumped whenever the store starts a new lifecycle (reset, or a load that
// established a project's threads) — lets a slow flush from a closed editor
// detect that its trailing reset has gone stale.
let _lifecycleGen = 0;

function threadsForFile(relPath: string): CommentThread[] {
  return allThreads().filter((t) => t.fileRelPath === relPath);
}

function openCommentThreadCount(): number {
  return allThreads().filter(
    (t) => t.status === "open" && (t.kind ?? "comment") !== "todo",
  ).length;
}

function openTodoThreads(): CommentThread[] {
  return allThreads().filter(
    (t) => t.status === "open" && (t.kind ?? "comment") === "todo",
  );
}

function openTodoThreadCount(): number {
  return openTodoThreads().length;
}

/**
 * Record what this install did to a thread it does not own, so the change
 * survives in our own shard rather than in the owner's file. A thread we own
 * needs nothing: its fields are the record.
 */
function notePatch(thread: CommentThread): void {
  if (isLocalAuthor(thread.authorId)) return;
  _myPatches[thread.id] = {
    at: threadClock(thread),
    status: thread.status,
    anchor: {
      fileRelPath: thread.fileRelPath,
      fromOffset: thread.fromOffset,
      toOffset: thread.toOffset,
      anchorText: thread.anchorText,
    },
  };
}

/** Apply `fn` to one thread, recording a patch when it belongs to someone else. */
function mutateThread(
  threadId: string,
  fn: (thread: CommentThread) => CommentThread,
): void {
  const touched: CommentThread[] = [];
  setAllThreads((prev) =>
    prev.map((t) => {
      if (t.id !== threadId) return t;
      const updated = fn(t);
      touched.push(updated);
      return updated;
    }),
  );
  for (const thread of touched) notePatch(thread);
  scheduleSave();
}

function addThread(thread: CommentThread): void {
  setAllThreads((prev) => [...prev, thread]);
  scheduleSave();
}

function addReplyToThread(threadId: string, author: CommentAuthor, body: string): void {
  // No patch: a reply is appended data, and `buildShard` files ours under the
  // thread's id whether or not we own the thread.
  setAllThreads((prev) =>
    prev.map((t) => (t.id === threadId ? addReply(t, author, body) : t)),
  );
  scheduleSave();
}

function resolveThreadById(threadId: string): void {
  mutateThread(threadId, resolveThread);
}

function reopenThreadById(threadId: string): void {
  mutateThread(threadId, reopenThread);
}

function removeThread(threadId: string): void {
  const thread = allThreads().find((t) => t.id === threadId);
  setAllThreads((prev) => prev.filter((t) => t.id !== threadId));
  if (thread !== undefined && !isLocalAuthor(thread.authorId)) {
    // A tombstone, because the thread lives in its owner's shard and we cannot
    // remove it from there. It has to outlive the thread or the next merge
    // brings it straight back.
    _myPatches[threadId] = { at: new Date().toISOString(), deleted: true };
  } else {
    delete _myPatches[threadId];
  }
  scheduleSave();
}

/**
 * Re-point an orphaned thread at a fresh range (the current editor selection).
 * The store is the single source of truth for anchors, so updating it here is
 * enough — the CM bridge re-derives decorations from the store.
 */
function reanchorThreadById(
  threadId: string,
  fromOffset: number,
  toOffset: number,
  anchorText: string,
): void {
  mutateThread(threadId, (t) => ({
    ...t,
    fromOffset,
    toOffset,
    anchorText: anchorText.slice(0, 80),
    updatedAt: new Date().toISOString(),
  }));
}

/**
 * Repoint every thread anchored to `oldRel` at `newRel` after a file rename, so
 * comments/TODOs stay attached to the renamed file. Offsets are unchanged — the
 * rename moved the exact bytes.
 */
function remapThreadFile(oldRel: string, newRel: string): void {
  remapThreads(
    (t) => t.fileRelPath === oldRel,
    () => newRel,
  );
}

/**
 * Directory-prefix sibling of {@link remapThreadFile}: repoint every thread
 * under a moved/renamed directory. Offsets are unchanged — the move relocated
 * the exact bytes.
 */
function remapThreadDir(oldDirRel: string, newDirRel: string): void {
  const prefix = `${oldDirRel}/`;
  remapThreads(
    (t) => t.fileRelPath.startsWith(prefix),
    (t) => newDirRel + t.fileRelPath.slice(oldDirRel.length),
  );
}

function remapThreads(
  matches: (thread: CommentThread) => boolean,
  nextPath: (thread: CommentThread) => string,
): void {
  const now = new Date().toISOString();
  const touched: CommentThread[] = [];
  setAllThreads((prev) =>
    prev.map((t) => {
      if (!matches(t)) return t;
      const updated = { ...t, fileRelPath: nextPath(t), updatedAt: now };
      touched.push(updated);
      return updated;
    }),
  );
  if (touched.length === 0) return;
  for (const thread of touched) notePatch(thread);
  scheduleSave();
}

function updateThreadOffsets(
  fileRelPath: string,
  updates: Array<{ id: string; fromOffset: number; toOffset: number; anchorText: string }>,
): void {
  const map = new Map(updates.map((u) => [u.id, u]));
  const now = new Date().toISOString();
  const touched: CommentThread[] = [];
  setAllThreads((prev) =>
    prev.map((t) => {
      if (t.fileRelPath !== fileRelPath) return t;
      const u = map.get(t.id);
      if (!u) return t;
      const updated = {
        ...t,
        fromOffset: u.fromOffset,
        toOffset: u.toOffset,
        anchorText: u.anchorText,
        updatedAt: now,
      };
      touched.push(updated);
      return updated;
    }),
  );
  for (const thread of touched) notePatch(thread);
  scheduleSave();
}

/**
 * A missing sidecar (fresh project, no reviews yet) is normal and writable; a
 * genuine read failure (permission, lock) must NOT be — hence the distinction.
 * We can't call the fs plugin here (its scope is Documents-only, but project
 * reads go through a custom root-registered IPC that also serves out-of-scope
 * roots), so we classify by the io error the Rust read surfaces. NotFound is
 * "os error 2" on every platform; anything else is treated as a real failure.
 */
function isNotFoundError(e: unknown): boolean {
  const msg = (
    typeof e === "string"
      ? e
      : e instanceof Error
        ? e.message
        : describeIpcError(e)
  ).toLowerCase();
  return (
    msg.includes("os error 2") ||
    msg.includes("no such file") ||
    msg.includes("cannot find the file") ||
    msg.includes("cannot find the path")
  );
}

interface ReadShards {
  /** Every shard that parsed, including ours. */
  shards: ReviewShard[];
  /** Our own shard, if it was present and parsed. */
  mine: ReviewShard | null;
  /** Our shard exists but could not be read or parsed: writing would destroy it. */
  mineUnreadable: boolean;
}

async function readShards(
  rootPath: string,
  localId: string,
  skipLocal: boolean,
): Promise<ReadShards | null> {
  let ids: string[];
  try {
    ids = await ipc.listReviewShards(rootPath);
  } catch (e) {
    recordError("reviews-load", `listing ${SIDECAR_DIR} failed`, e);
    return null;
  }

  const shards: ReviewShard[] = [];
  let mine: ReviewShard | null = null;
  let mineUnreadable = false;
  for (const id of ids) {
    const isMine = id === localId;
    if (isMine && skipLocal) continue;
    let raw: string;
    try {
      raw = await ipc.readProjectTextFile(rootPath, shardRelPath(id));
    } catch (e) {
      // A shard that vanished between listing and reading is not an error: a
      // sync client rewrites files in place all the time.
      if (isNotFoundError(e)) continue;
      recordError("reviews-load", `reading shard ${id} failed`, e);
      if (isMine) mineUnreadable = true;
      continue;
    }
    const shard = parseShard(raw, id);
    if (shard === null) {
      // Corrupt shard. Ours must not be overwritten (someone can still repair
      // it by hand); a collaborator's is simply left out of the merge.
      recordError("reviews-load", `shard ${id} is not a review shard`);
      if (isMine) mineUnreadable = true;
      continue;
    }
    shards.push(shard);
    if (isMine) mine = shard;
  }
  return { shards, mine, mineUnreadable };
}

async function loadThreads(isCurrent: () => boolean = () => true): Promise<void> {
  const proj = project();
  if (!proj) return;
  const author = localAuthor();
  const read = await readShards(proj.rootPath, author.id, false);
  if (!isCurrent() || read === null) return;
  if (read.mineUnreadable) {
    // Stay read-only so the next save can't overwrite our own threads, which
    // are present on disk but failed to load.
    return;
  }
  _lifecycleGen++;
  setAllThreads(mergeShards(read.shards));
  _myPatches = { ...(read.mine?.patches ?? {}) };
  _myShardAtLoad = read.mine;
  _loaded = true;
  // Without an identity there is no shard name to write to. The panel still
  // renders everything it found; it just cannot add to it until Rust's startup
  // seeding has reached the renderer.
  _readOnly = !hasLocalIdentity();
}

/**
 * Debounced entry point for the watcher. A sync client landing several shards
 * at once, and our own saves (which the watcher also sees), would otherwise
 * each drive a full re-read.
 */
function noteReviewShardsChanged(): void {
  if (_reloadTimer) clearTimeout(_reloadTimer);
  _reloadTimer = setTimeout(() => {
    _reloadTimer = null;
    void reloadThreadsFromDisk();
  }, RELOAD_DEBOUNCE_MS);
}

/**
 * Re-merge after the shards changed on disk, and announce anything new that
 * someone else wrote. Driven by the file watcher, which is how a comment made
 * in a folder-synced project reaches the other people looking at it.
 *
 * Our own shard is rebuilt from memory rather than re-read: memory is at least
 * as new as the file we just wrote, so our own save's watcher event resolves to
 * a no-op instead of a race.
 */
async function reloadThreadsFromDisk(): Promise<void> {
  const proj = project();
  if (!proj || !_loaded) return;
  const rootPath = proj.rootPath;
  const author = localAuthor();
  const gen = _lifecycleGen;
  const read = await readShards(rootPath, author.id, true);
  if (read === null) return;
  // A project switch (or a reset) during the read invalidates everything the
  // merge below would be built on.
  if (gen !== _lifecycleGen || project()?.rootPath !== rootPath) return;

  const before = allThreads();
  // Without an identity we own nothing and have written nothing, so there is no
  // local shard to fold in — and an empty-id one would merge as a real author.
  const merged = mergeShards(
    author.id === "" ? read.shards : [...read.shards, currentLocalShard(author)],
  );
  announceArrivals(before, merged);
  setAllThreads(merged);
}

/** New threads and replies written by someone else since the last merge. */
function announceArrivals(before: CommentThread[], after: CommentThread[]): void {
  const known = new Map(before.map((t) => [t.id, t]));
  const arrivals: Array<{ thread: CommentThread; comment: Comment }> = [];

  for (const thread of after) {
    const previous = known.get(thread.id);
    if (previous === undefined) {
      const root = thread.comments[0];
      if (root !== undefined && !isLocalAuthor(root.authorId)) {
        arrivals.push({ thread, comment: root });
      }
      continue;
    }
    const seen = new Set(previous.comments.map((c) => c.id));
    for (const comment of thread.comments) {
      if (seen.has(comment.id) || isLocalAuthor(comment.authorId)) continue;
      arrivals.push({ thread, comment });
    }
  }
  if (arrivals.length === 0) return;

  for (const { thread, comment } of arrivals.slice(0, MAX_ARRIVAL_NOTIFICATIONS)) {
    pushNotification({
      kind: "info",
      title: `${comment.author} commented on ${thread.fileRelPath}`,
      body: comment.body.slice(0, 200),
      // One row per thread: a back-and-forth refreshes it instead of stacking.
      key: `review:${thread.id}`,
    });
  }
  const names = [...new Set(arrivals.map((a) => a.comment.author))];
  notifyInfo(
    arrivals.length === 1 ? "New review comment" : `${arrivals.length} new review comments`,
    `From ${names.join(", ")}`,
  );
}

/**
 * Our shard as it should be on disk right now: derived from the merged view,
 * plus any replies we wrote on threads that view is currently missing (an
 * owner's shard that failed to read, or has not synced down yet).
 */
function currentLocalShard(author: CommentAuthor): ReviewShard {
  const shard = buildShard(author, allThreads(), _myPatches);
  if (_myShardAtLoad !== null) {
    const visible = new Set(allThreads().map((t) => t.id));
    for (const [threadId, comments] of Object.entries(_myShardAtLoad.replies)) {
      if (!visible.has(threadId)) shard.replies[threadId] = comments;
    }
  }
  return shard;
}

function scheduleSave(): void {
  if (_readOnly) return;
  if (_saveTimer) clearTimeout(_saveTimer);
  _pendingRoot = project()?.rootPath ?? null;
  _saveTimer = setTimeout(() => {
    _saveTimer = null;
    const root = _pendingRoot;
    _pendingRoot = null;
    // A project switch flushes pending saves explicitly; if the timer still
    // fires across one (missed flush), refuse rather than cross-write.
    if (root && root === project()?.rootPath) void writeThreads(root);
  }, SAVE_DEBOUNCE_MS);
}

/**
 * Write any pending debounced save immediately, to the project that was
 * active when it was scheduled. Call before resetting on a project switch.
 */
async function flushPendingReviewSave(): Promise<void> {
  if (!_saveTimer) return;
  clearTimeout(_saveTimer);
  _saveTimer = null;
  const root = _pendingRoot;
  _pendingRoot = null;
  if (root) await writeThreads(root);
}

/**
 * Flush any pending save, then clear the store — unless another project's
 * threads loaded meanwhile. A slow flush from a closed editor must not wipe
 * (and read-only-lock) the reopened project's freshly loaded threads; the
 * write itself is safe to keep because the flush snapshots its payload and
 * target root synchronously, before the first await.
 */
async function flushAndResetThreads(): Promise<void> {
  const gen = _lifecycleGen;
  await flushPendingReviewSave();
  if (gen === _lifecycleGen) resetThreads();
}

/** Clear in-memory threads on project switch/close (cancels pending saves). */
function resetThreads(): void {
  _lifecycleGen++;
  if (_saveTimer) {
    clearTimeout(_saveTimer);
    _saveTimer = null;
  }
  _pendingRoot = null;
  if (_reloadTimer) {
    clearTimeout(_reloadTimer);
    _reloadTimer = null;
  }
  _writeErrorToastedRoot = null;
  // Block saves until loadThreads establishes what's on disk for the next
  // project — otherwise a mutation in the load gap could overwrite it.
  _readOnly = true;
  _loaded = false;
  _myPatches = {};
  _myShardAtLoad = null;
  setAllThreads([]);
}

async function writeThreads(rootPath: string): Promise<void> {
  if (_readOnly) return;
  const author = localAuthor();
  if (author.id === "") return;
  const relPath = shardRelPath(author.id);
  const data = JSON.stringify(currentLocalShard(author), null, 2);
  try {
    await ipc.writeProjectTextFile(rootPath, relPath, data);
    if (_writeErrorToastedRoot === rootPath) _writeErrorToastedRoot = null;
  } catch (e) {
    // Review comments are primary user data with no other persistence — a
    // silent drop is data loss. Surface it (once per project) and keep the
    // save "dirty" by re-arming the debounce so it retries.
    recordError("reviews-save", `writing ${relPath} failed`, e);
    if (_writeErrorToastedRoot !== rootPath) {
      _writeErrorToastedRoot = rootPath;
      notifyError("Couldn't save review comments", describeIpcError(e));
    }
    if (rootPath === project()?.rootPath) scheduleSave();
  }
}

function _resetForTests(): void {
  resetThreads();
  setShowResolved(false);
}

export {
  allThreads,
  showResolved,
  setShowResolved,
  reviewPanelIntent,
  setReviewPanelIntent,
  focusedThreadId,
  setFocusedThreadId,
  threadsForFile,
  openCommentThreadCount,
  openTodoThreads,
  openTodoThreadCount,
  addThread,
  addReplyToThread,
  resolveThreadById,
  reopenThreadById,
  removeThread,
  reanchorThreadById,
  remapThreadDir,
  remapThreadFile,
  updateThreadOffsets,
  loadThreads,
  noteReviewShardsChanged,
  reloadThreadsFromDisk,
  flushPendingReviewSave,
  flushAndResetThreads,
  resetThreads,
  _resetForTests,
};
