import { describe, isActiveState, phaseOf, type Phase, type Problem, type QueueState, type SearchOutcome, type WorkPhase } from '@ladarr/shared/queue';
import type { EpisodeRef } from '@ladarr/shared/types';
import type { Continuation } from '../parse.ts';
import { type Db, db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import { catalog, deleteItemLog, itemFields } from '../../core/log.ts';

// The journey of a target, kept as one state. A caller never writes a stage, a branch, or a reason by itself: it asks
// for an operation, and the operation checks the change and leaves a record.
export type Stage = Phase;

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
  // The comment of the torrent file, when the indexer sent one. A magnet has none.
  comment?: string;
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

// One change of the state. `stage` repeats the phase, so a reader of an old record and the item log keep the same line.
export type HistoryEvent = { at: number; state: QueueState; stage: Phase; attempt: number; cause: string; detail?: string };

// A release of the last search that was rejected. A person can take it by hand. The link stays on the server: it
// carries the API key.
export type RejectedRelease = {
  indexerId: number;
  guid: string;
  title: string;
  link: string | null;
  magnet: string | null;
  infoHash: string | null;
  sizeBytes: number;
  seeders: number | null;
  resolution: number | null;
  source: string;
  kind: 'single' | 'multi' | 'pack';
  reasons: string[];
  // The size check that stopped the release, with the numbers. Null when the size did not stop it.
  sizeRejection: { code: 'size_below_min' | 'size_above_max'; value: number; limit: number } | null;
};

export type SearchState = {
  at: number;
  indexers: { id: number; name: string; state: 'waiting' | 'done' | 'failed' | 'skipped'; count: number | null; error?: string }[];
  candidates: number;
  accepted: number;
  result: 'grabbed' | 'deferred' | 'no_results' | 'all_rejected' | 'indexers_failed' | null;
  // The rejection codes that stopped the most releases, most frequent first.
  topRejections: string[];
  nextAt: number | null;
  // The releases that only the preferences rejected, so a person can pick one for a manual download.
  rejected: RejectedRelease[];
};

export type ImportResult = { at: number; ok: boolean; method: 'hardlink' | 'copy' | null; path: string | null; validation: 'ffprobe' | 'basic'; detail?: string };

export type QueueEntry = {
  // "movie:603" or "tv:1396:1x2". The same target always has the same ID.
  id: string;
  titleKey: string;
  season: number | null;
  number: number | null;
  // The one state of the target. Every status and every tab comes from it.
  state: QueueState;
  // Rises with each change. A message with an older number is stale.
  revision: number;
  createdAt: number;
  // When the target entered its current state, including a block.
  stateSince: number;
  // When the target entered its current phase, so the poller keeps its grace period after a block clears.
  phaseSince: number;
  completedAt: number | null;
  // Set by Clear. The entry leaves the main view and stays in the history.
  clearedAt: number | null;
  // Position in the priority lane, or null for the normal lane.
  priority: number | null;
  attempt: number;
  attempts: Attempt[];
  history: HistoryEvent[];
  search: SearchState | null;
  release: ReleaseRef | null;
  transferHash: string | null;
  // The download client that has the torrent. Set with the hash.
  clientId: string | null;
  // Set when the user chose the file by hand. The import and the retries keep it.
  manualMatch: { file: string; covers: Covered[] } | null;
  // Set when the user chose to replace the file that holds the destination name. The importer clears it.
  replaceDestination?: boolean;
  importResult: ImportResult | null;
  // Set when the releases count as two seasons what the title counts as one. The targets of the rest of the season then
  // search the next season of the release. Null or absent for the numbering of the title.
  continuation?: Continuation | null;
};

const MAX_HISTORY = 100;
const MAX_ATTEMPTS_KEPT = 20;
const FLUSH_MS = 100;
const pad = (n: number) => String(n).padStart(2, '0');

export const entryId = (titleKey: string, season: number | null, number: number | null) => (season === null || number === null ? titleKey : `${titleKey}:${season}x${number}`);

// An entry is active until it is available, or cancelled by the user.
export const isActive = (entry: QueueEntry) => isActiveState(entry.state);

// The phase of an entry, for the callers that need the operation only.
export const phaseOfEntry = (entry: QueueEntry) => phaseOf(entry.state);
export const stageOf = phaseOfEntry;

// The problem of a stuck target, or the result of the search that keeps it waiting. A target that moves has none.
const WAITING_REASON = { no_results: 'no_results', all_rejected: 'all_rejected', deferred: 'search_deferred', indexers_failed: 'indexers_failed' } as const;
export const reasonOfEntry = (entry: QueueEntry) =>
  entry.state.kind === 'blocked' ? entry.state.problem : entry.state.kind === 'waiting' && entry.state.outcome !== 'unspecified' ? { code: WAITING_REASON[entry.state.outcome] } : null;

// A torrent belongs to ladarr when ladarr sent it to the client. The record of the sent torrents keeps it after a new
// search clears the hash of a target, and after the target that sent it is gone. A file from before the record keeps
// the step in the history of the target. A torrent that the user attached is the user's, and a target that still looks
// for a release has not sent a torrent yet.
const EARLY: readonly Phase[] = ['queued', 'searching', 'fetching'];
const sentThisRelease = (entry: QueueEntry) =>
  entry.release !== null && entry.history.some((event) => event.stage === 'sending' && event.detail === entry.release?.title);
export function addedByApp(hash: string) {
  if (db.data.sentTorrents[hash]) return true;
  const entries = Object.values(db.data.queue).filter((entry) => entry.transferHash === hash);
  if (entries.some((entry) => entry.release?.external)) return false;
  return entries.some((entry) => !EARLY.includes(phaseOf(entry.state)) || sentThisRelease(entry));
}

// `onState` runs after each change of the state, with the state from before the change.
export type StateHook = (entry: QueueEntry, before: QueueState) => void;

const clone = (state: QueueState): QueueState => (state.kind === 'blocked' ? { ...state, problem: { ...state.problem } } : state.kind === 'paused' ? { ...state, problem: state.problem ? { ...state.problem } : null } : { ...state });

const sameState = (a: QueueState, b: QueueState) => JSON.stringify(a) === JSON.stringify(b);

// The permitted changes. A target that is available or cancelled leaves the queue, and only a new request takes it
// back. Every other change is a step of the journey, a problem, or the pause of a step.
function canEnter(from: QueueState, to: QueueState) {
  if (from.kind === 'available' || from.kind === 'cancelled') return to.kind === 'queued' || to.kind === from.kind;
  return true;
}

const statusText = (state: QueueState) => describe(state).status;

export function createQueue(events: Events, persist: () => void, onState?: StateHook) {
  const changed = new Set<string>();
  let timer: NodeJS.Timeout | undefined;

  // Sends the changed IDs together, so a burst of changes is one message.
  function flush() {
    timer = undefined;
    const ids = [...changed];
    changed.clear();
    if (ids.length) events.publish('queue.changed', { cursor: db.data.queueRev, ids: ids.slice(0, 500), overflow: ids.length > 500 });
  }

  // Tells the pages that one target changed. A state change and an observation both use it.
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
      state: { kind: 'queued' },
      revision: 0,
      createdAt: now,
      stateSince: now,
      phaseSince: now,
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
    catalog.info('queued', 'Added to the queue', itemFields(entry), { season, number, status: 'queued' });
    return entry;
  }

  // The only place that writes the state. Every operation below goes through it.
  function transition(entry: QueueEntry, next: QueueState, cause: string, detail?: string) {
    const before = entry.state;
    if (sameState(before, next)) return;
    if (!canEnter(before, next)) throw new Error(`The queue does not allow ${before.kind} to become ${next.kind}.`);
    const now = Date.now();
    const phaseBefore = phaseOf(before);
    const phaseAfter = phaseOf(next);
    entry.state = next;
    entry.stateSince = now;
    if (phaseAfter !== phaseBefore) entry.phaseSince = now;
    // A repeated completion keeps the first time. The hook does not send a second event.
    if (next.kind === 'available' && entry.completedAt === null) entry.completedAt = now;
    entry.history.push({ at: now, state: clone(next), stage: phaseAfter, attempt: entry.attempt, cause, ...(detail ? { detail } : {}) });
    if (entry.history.length > MAX_HISTORY) entry.history.splice(0, entry.history.length - MAX_HISTORY);
    const fields = { from: statusText(before), to: statusText(next), phase: phaseAfter, problem: next.kind === 'blocked' ? next.problem.code : null, cause, ...(detail ? { detail } : {}) };
    // An item that is available left the queue, so the whole log of the item goes with it.
    if (next.kind === 'available' && before.kind !== 'available') deleteItemLog(entry.id);
    // The line names the change, and the cause stays in the fields. The fields hold the phase before and after.
    const line = cause.charAt(0).toUpperCase() + cause.slice(1);
    catalog.info('moved', line, { ...itemFields(entry), status: statusText(next) }, fields);
    touch(entry);
    onState?.(entry, before);
  }

  // A fact that does not change the state, such as the client that accepted a torrent after the user cancelled it.
  function observe(entry: QueueEntry, cause: string, detail?: string) {
    const now = Date.now();
    entry.history.push({ at: now, state: clone(entry.state), stage: phaseOf(entry.state), attempt: entry.attempt, cause, ...(detail ? { detail } : {}) });
    if (entry.history.length > MAX_HISTORY) entry.history.splice(0, entry.history.length - MAX_HISTORY);
    catalog.info('observed', cause, { ...itemFields(entry), status: statusText(entry.state) }, detail ? { detail } : {});
    touch(entry);
  }

  function enter(entry: QueueEntry, phase: WorkPhase, cause: string, detail?: string) {
    transition(entry, { kind: phase }, cause, detail);
  }

  function wait(entry: QueueEntry, outcome: SearchOutcome, cause: string, detail?: string) {
    transition(entry, { kind: 'waiting', outcome }, cause, detail);
  }

  // A problem stops the target at the phase where it was found.
  function block(entry: QueueEntry, problem: Problem, cause: string, detail?: string) {
    const at = phaseOf(entry.state);
    if (at === 'available') return;
    transition(entry, { kind: 'blocked', at, problem }, cause, detail);
  }

  // The problem is gone, and the target goes on from the phase that it stopped at.
  function unblock(entry: QueueEntry, cause: string) {
    if (entry.state.kind !== 'blocked') return;
    transition(entry, { kind: entry.state.at }, cause);
  }

  // The pause keeps the phase and the problem, so a resume restores them without a guess.
  function pause(entry: QueueEntry, cause: string) {
    if (entry.state.kind === 'paused' || entry.state.kind === 'available') return;
    const resume = phaseOf(entry.state);
    const problem = entry.state.kind === 'blocked' ? entry.state.problem : null;
    transition(entry, { kind: 'paused', resume, problem }, cause);
  }

  function resume(entry: QueueEntry, cause: string) {
    if (entry.state.kind !== 'paused') return;
    const { resume: phase, problem } = entry.state;
    transition(entry, phase === 'available' ? { kind: 'available' } : problem ? { kind: 'blocked', at: phase, problem } : { kind: phase }, cause);
  }

  function complete(entry: QueueEntry, cause: string, detail?: string) {
    transition(entry, { kind: 'available' }, cause, detail);
  }

  function cancel(entry: QueueEntry, cause: string) {
    if (entry.state.kind === 'available') return;
    transition(entry, { kind: 'cancelled', at: phaseOf(entry.state) }, cause);
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
    catalog.info('started', `Attempt ${entry.attempt} to find "${name}"`, itemFields(entry), { reason });
  }

  function endAttempt(entry: QueueEntry, outcome: Attempt['outcome'], detail?: string) {
    const attempt = entry.attempts.at(-1);
    if (attempt?.outcome !== 'running') return;
    Object.assign(attempt, { outcome, endedAt: Date.now(), ...(detail ? { detail } : {}) });
    catalog.info('attempt_ended', `Attempt ${entry.attempt} ended: ${outcome}${detail ? ` (${detail})` : ''}`, itemFields(entry), { outcome, ...(detail ? { detail } : {}) });
  }

  // The file that an imported target gave keeps the torrent of its entry, so a removal can delete that torrent later.
  function rememberDownload(entry: QueueEntry) {
    const attempt = entry.attempts.at(-1);
    if (attempt?.outcome !== 'imported' || !entry.importResult?.ok) return;
    if (!entry.clientId || !entry.transferHash) return;
    const title = db.data.titles[entry.titleKey];
    if (!title) return;
    const fileId =
      title.mediaType === 'movie'
        ? title.fileId
        : (title.episodes.find((episode) => episode.season === entry.season && episode.number === entry.number)?.fileId ?? null);
    const file = fileId ? db.data.files[fileId] : undefined;
    if (!file || file.download) return;
    file.download = { clientId: entry.clientId, hash: entry.transferHash, external: entry.release?.external === true };
  }

  // A request for a target. It returns false when the target is already in the journey, so no second request starts.
  function request(entry: QueueEntry, reason: string) {
    // An entry that was made but never requested has no attempt yet.
    if (entry.attempt > 0 && isActive(entry)) return false;
    rememberDownload(entry);
    Object.assign(entry, { search: null, release: null, transferHash: null, clientId: null, importResult: null, clearedAt: null, completedAt: null, manualMatch: entry.manualMatch });
    startAttempt(entry, reason);
    // A target that is already queued keeps its state. The record says why the attempt started.
    if (entry.state.kind === 'queued') observe(entry, reason);
    else transition(entry, { kind: 'queued' }, reason);
    return true;
  }

  // A confirmed bad download or a target that its pack does not cover starts again from the top of the journey. The
  // caller ends the attempt first. It keeps the new attempt in the history of the target.
  function fallback(entry: QueueEntry, cause: string, detail?: string, attemptReason = `fallback: ${cause}`) {
    Object.assign(entry, { search: null, release: null, transferHash: null, clientId: null, importResult: null, replaceDestination: undefined });
    startAttempt(entry, attemptReason);
    transition(entry, { kind: 'queued' }, 'fallback', detail ?? cause);
  }

  // A new try that keeps the state of the target. The worker resolves the target through the phases of its journey.
  function retryAttempt(entry: QueueEntry, reason = 'retry') {
    endAttempt(entry, 'failed', reason);
    startAttempt(entry, reason);
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

  return {
    ensure,
    transition,
    enter,
    wait,
    block,
    unblock,
    pause,
    resume,
    complete,
    cancel,
    observe,
    request,
    fallback,
    retryAttempt,
    startAttempt,
    endAttempt,
    setPriority,
    setPaused,
    notify,
    touch,
    get: (id: string) => db.data.queue[id],
  };
}

export type Queue = ReturnType<typeof createQueue>;
