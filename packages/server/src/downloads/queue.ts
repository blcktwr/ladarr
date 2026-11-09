import type { QueueBranch, QueueStage } from '@ladarr/shared/enums';
import type { EpisodeRef } from '@ladarr/shared/types';
import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { catalog, deleteItemLog, itemFields } from '../core/log.ts';

// The journey of a target: Queued, Searching, Fetching the release, Sending to client, Downloading, Validating, Importing, Available.
// A stage can be skipped when its work is not needed. A stage never shows progress that did not happen.
export type Stage = QueueStage;
export const STAGES: readonly Stage[] = ['queued', 'searching', 'fetching', 'sending', 'downloading', 'validating', 'importing', 'available'];

// A branch is a state beside the journey. It does not move the entry forward.
// "waiting" means that no release is eligible yet.
// A target that cannot go on keeps its stage and holds the reason that stops it.
export type Branch = QueueBranch;

export type Reason = { code: string; detail?: string };

export type Covered = EpisodeRef;

// The release that an entry has. A pack gives the same release to several entries.
export type ReleaseRef = {
  guid: string;
  indexerId: number;
  indexerName: string;
  title: string;
  sizeBytes: number;
  infoHash: string | null;
  link: string | null;
  magnet: string | null;
  kind: 'single' | 'multi' | 'pack';
  seeders: number | null;
  manual: boolean;
  // The share limits that the indexer asked for when ladarr chose the release. Old entries lack it.
  seed?: { ratio: number | null; minutes: number | null } | null;
  // Set when the user attached a download that was in the client already. ladarr did not add it, and never removes it.
  external?: boolean;
};

export type Attempt = {
  n: number;
  startedAt: number;
  endedAt: number | null;
  // Why the attempt started: the first request, a retry, or the fallback after a bad release.
  reason: string;
  release: string | null;
  outcome: 'running' | 'imported' | 'failed' | 'cancelled';
  detail?: string;
};

export type StageEvent = { at: number; stage: Stage; branch: Branch | null; attempt: number; cause: string; detail?: string };

export type SearchState = {
  at: number;
  indexers: { id: number; name: string; state: 'waiting' | 'done' | 'failed' | 'skipped'; count: number | null; error?: string }[];
  candidates: number;
  accepted: number;
  result: 'grabbed' | 'deferred' | 'no_results' | 'all_rejected' | 'indexers_failed' | null;
  // The rejection codes that stopped the most releases, most frequent first.
  topRejections: string[];
  nextAt: number | null;
};

export type ImportResult = { at: number; ok: boolean; method: 'hardlink' | 'copy' | null; path: string | null; validation: 'ffprobe' | 'basic'; detail?: string };

export type QueueEntry = {
  // "movie:603" or "tv:1396:1x2". The same target always has the same ID.
  id: string;
  titleKey: string;
  season: number | null;
  number: number | null;
  stage: Stage;
  branch: Branch | null;
  reason: Reason | null;
  // Rises with each change. A message with an older number is stale.
  revision: number;
  createdAt: number;
  stageSince: number;
  completedAt: number | null;
  // Set by Clear. The entry leaves the main view and stays in the history.
  clearedAt: number | null;
  // Position in the priority lane, or null for the normal lane.
  priority: number | null;
  attempt: number;
  attempts: Attempt[];
  history: StageEvent[];
  search: SearchState | null;
  release: ReleaseRef | null;
  transferHash: string | null;
  // The download client that has the torrent. Set with the hash.
  clientId: string | null;
  // Set when the user chose the file by hand. The import and the retries keep it.
  manualMatch: { file: string; covers: Covered[] } | null;
  importResult: ImportResult | null;
};

const MAX_HISTORY = 100;
const MAX_ATTEMPTS_KEPT = 20;
const FLUSH_MS = 100;
const pad = (n: number) => String(n).padStart(2, '0');

export const entryId = (titleKey: string, season: number | null, number: number | null) => (season === null || number === null ? titleKey : `${titleKey}:${season}x${number}`);

// An entry is active until it is available, or cancelled by the user.
export const isActive = (entry: QueueEntry) => entry.stage !== 'available' && entry.branch !== 'cancelled';

// The key that the pages show for an entry: the branch if there is one, else the stage. A target that waits for its
// next search shows the result that keeps it there: no release found, or no release that fits the preset. A target
// that a reason blocks shows that it is stuck.
export const queueKey = (entry: Pick<QueueEntry, 'branch' | 'stage' | 'reason'>) =>
  entry.branch === 'waiting' && entry.reason?.code === 'no_results'
    ? 'not_found'
    : entry.branch === 'waiting' && entry.reason?.code === 'all_rejected'
      ? 'no_match'
      : entry.branch === null && entry.reason !== null
        ? 'stuck'
        : (entry.branch ?? entry.stage);

// The series whose first search waits for its episodes. A series has a target for each episode, so it has none
// until the episodes arrive. The queue shows the series itself as searching meanwhile.
export function loadingTitleKeys(db: Db) {
  const keys = new Set<string>();
  for (const job of Object.values(db.data.jobs)) {
    // A job that runs already made its targets, or has none to make. Only a waiting job is a title that waits.
    if (job.type !== 'queue.initial' || job.state !== 'waiting') continue;
    const key = (job.payload as { key?: unknown } | null)?.key;
    if (typeof key === 'string') keys.add(key);
  }
  for (const key of [...keys]) {
    const title = db.data.titles[key];
    const target = Object.values(db.data.queue).some((entry) => entry.titleKey === key && entry.attempt > 0 && !entry.clearedAt);
    if (!title || title.mediaType !== 'tv' || title.paused || target) keys.delete(key);
  }
  return keys;
}

// A torrent belongs to ladarr when a target that ladarr sent to the client has its hash. A torrent that the user
// attached is the user's, and a target that still looks for a release has not sent a torrent yet.
const EARLY: readonly Stage[] = ['queued', 'searching', 'fetching'];
export function addedByApp(db: Db, hash: string) {
  const entries = Object.values(db.data.queue).filter((entry) => entry.transferHash === hash);
  if (entries.some((entry) => entry.release?.external)) return false;
  return entries.some((entry) => !EARLY.includes(entry.stage));
}

// `onMove` runs after each change of the stage or the branch, with the values from before the change.
export type MoveHook = (entry: QueueEntry, before: { stage: Stage; branch: Branch | null; reason: Reason | null }) => void;

export function createQueue(db: Db, events: Events, persist: () => void, onMove?: MoveHook) {
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  // Sends the changed IDs together, so a burst of changes is one message.
  function flush() {
    timer = undefined;
    const ids = [...changed];
    changed.clear();
    if (ids.length) events.publish('queue.changed', { cursor: db.data.queueRev, ids: ids.slice(0, 500), overflow: ids.length > 500 });
  }

  function touch(entry: QueueEntry) {
    entry.revision = ++db.data.queueRev;
    changed.add(entry.id);
    timer ??= setTimeout(flush, FLUSH_MS);
    persist();
  }

  function ensure(titleKey: string, season: number | null, number: number | null): QueueEntry {
    const id = entryId(titleKey, season, number);
    const now = Date.now();
    const found = db.data.queue[id];
    if (found) return found;
    const entry = (db.data.queue[id] = {
      id,
      titleKey,
      season,
      number,
      stage: 'queued',
      branch: null,
      reason: null,
      revision: 0,
      createdAt: now,
      stageSince: now,
      completedAt: null,
      clearedAt: null,
      priority: null,
      attempt: 0,
      attempts: [],
      history: [],
      search: null,
      release: null,
      transferHash: null,
      clientId: null,
      manualMatch: null,
      importResult: null,
    });
    catalog.info('queued', 'Added to the queue', itemFields(db, entry), { season, number });
    return entry;
  }

  type Change = { stage?: Stage; branch?: Branch | null; reason?: Reason | null };

  // One place changes the stage, so each change leaves a record.
  function move(entry: QueueEntry, change: Change, cause: string, detail?: string) {
    const now = Date.now();
    const before = { stage: entry.stage, branch: entry.branch, reason: entry.reason };
    if (change.stage && change.stage !== entry.stage) {
      entry.stage = change.stage;
      entry.stageSince = now;
    }
    if ('branch' in change) entry.branch = change.branch ?? null;
    if ('reason' in change) entry.reason = change.reason ?? null;
    if (entry.stage === 'available') entry.completedAt = now;
    entry.history.push({ at: now, stage: entry.stage, branch: entry.branch, attempt: entry.attempt, cause, ...(detail ? { detail } : {}) });
    if (entry.history.length > MAX_HISTORY) entry.history.splice(0, entry.history.length - MAX_HISTORY);
    // The log of an item says each step of its journey, so a person reads the whole process in one place.
    const fields = { from: before.stage, to: entry.stage, branch: entry.branch, reason: entry.reason?.code ?? null, cause, ...(detail ? { detail } : {}) };
    if (entry.stage !== before.stage || entry.branch !== before.branch) {
      const from = before.branch ? `${before.stage} (${before.branch})` : before.stage;
      const to = entry.branch ? `${entry.stage} (${entry.branch})` : entry.stage;
      // The line names the change, as the log of Sonarr does, and the cause stays in the fields.
      catalog.info('moved', `Changed status from ${from} to ${to}`, { ...itemFields(db, entry), status: entry.branch ?? entry.stage }, fields);
    }
    // An item that is available left the queue, so the whole log of the item goes with it.
    if (entry.stage === 'available' && before.stage !== 'available') deleteItemLog(entry.id);
    touch(entry);
    onMove?.(entry, before);
  }

  function startAttempt(entry: QueueEntry, reason: string) {
    entry.attempt++;
    entry.attempts.push({ n: entry.attempt, startedAt: Date.now(), endedAt: null, reason, release: null, outcome: 'running' });
    if (entry.attempts.length > MAX_ATTEMPTS_KEPT) entry.attempts.shift();
    // The line names the target, so the reason of the try stays in the fields.
    const title = db.data.titles[entry.titleKey];
    const name = !title
      ? entry.titleKey
      : entry.season === null
        ? `${title.meta.title}${title.meta.year ? ` (${title.meta.year})` : ''}`
        : `${title.meta.title} S${pad(entry.season)}E${pad(entry.number!)}`;
    catalog.info('started', `Attempt ${entry.attempt} to find "${name}"`, itemFields(db, entry), { reason });
  }

  function endAttempt(entry: QueueEntry, outcome: Attempt['outcome'], detail?: string) {
    const attempt = entry.attempts.at(-1);
    if (attempt?.outcome !== 'running') return;
    Object.assign(attempt, { outcome, endedAt: Date.now(), ...(detail ? { detail } : {}) });
    catalog.info('attempt_ended', `Attempt ${entry.attempt} ended: ${outcome}${detail ? ` (${detail})` : ''}`, itemFields(db, entry), { outcome, ...(detail ? { detail } : {}) });
  }

  // A request for a target. It returns false when the target is already in the journey, so no second request starts.
  function request(entry: QueueEntry, reason: string) {
    // An entry that was made but never requested has no attempt yet.
    if (entry.attempt > 0 && isActive(entry)) return false;
    Object.assign(entry, { search: null, release: null, transferHash: null, clientId: null, importResult: null, clearedAt: null, completedAt: null, manualMatch: entry.manualMatch });
    startAttempt(entry, reason);
    move(entry, { stage: 'queued', branch: null, reason: null }, reason);
    return true;
  }

  // The jobs of the entry go to the priority lane with it. The caller does that, because jobs know the entry only by ID.
  function setPriority(entry: QueueEntry, on: boolean) {
    if (on === (entry.priority !== null)) return;
    entry.priority = on ? db.data.prioritySeq++ : null;
    touch(entry);
  }

  // The queue stops its work, and the pages show the new state. The data keeps the state after a restart.
  function setPaused(value: boolean) {
    db.data.queuePaused = value;
    persist();
    events.publish('queue.changed');
  }

  // Tells the pages that the queue changed. A title can leave the queue with no change of an entry, when its
  // first search finds no target.
  function notify() {
    events.publish('queue.changed');
  }

  return { ensure, move, request, startAttempt, endAttempt, setPriority, setPaused, notify, touch, get: (id: string) => db.data.queue[id] };
}

export type Queue = ReturnType<typeof createQueue>;
