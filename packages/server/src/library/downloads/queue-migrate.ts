import { isActiveState, itemId, phaseOf, type Phase, type QueueState, type SearchOutcome, type WorkPhase } from '@ladarr/shared/queue';
import type { Data, ImportJournal, Job, LegacyEntry, QueueEntry, QueueTorrent, QueueTurn, SearchPayload, StoredEvent } from '../../types.ts';
import { newTurn, seasonHasCoverage } from './queue.ts';
import { detach } from '../grab/detach.ts';

const WORK: readonly Phase[] = ['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing'];

// An older version checked a download in a stage of its own. The import checks that download now, so the stage is the
// import. The value stays in an older file, and the type does not have it.
const REMOVED: Record<string, WorkPhase> = { validating: 'importing' };

const phaseOfLegacy = (value: string | undefined): Phase => {
  if (!value) return 'queued';
  if (value === 'available') return 'available';
  return REMOVED[value] ?? (WORK.find((phase) => phase === value) ?? 'queued');
};

const outcomeOf = (code: string | undefined): SearchOutcome =>
  code === 'no_results' ? 'no_results' : code === 'all_rejected' ? 'all_rejected' : code === 'search_deferred' ? 'deferred' : code === 'indexers_failed' ? 'indexers_failed' : 'unspecified';

// The phase that a saved state means now. A stage that no longer exists becomes the stage that holds its work.
function phaseOfState(state: QueueState): Phase {
  const phase = phaseOf(state);
  return REMOVED[phase as string] ?? phase;
}

function stateOfPhase(state: QueueState): QueueState {
  switch (state.kind) {
    case 'blocked': {
      const at = REMOVED[state.at as string];
      return at ? { ...state, at } : state;
    }
    case 'paused': {
      const resume = REMOVED[state.resume as string];
      return resume ? { ...state, resume } : state;
    }
    case 'cancelled': {
      const at = REMOVED[state.at as string];
      return at ? { ...state, at } : state;
    }
    default: {
      const kind = REMOVED[state.kind as string];
      return kind ? ({ kind } as QueueState) : state;
    }
  }
}

// The state that an older entry means. A null branch with a reason is a problem, and the reason stays with it.
function stateOf(stage: string | undefined, branch: string | null | undefined, reason: { code: string; detail?: string } | null | undefined): QueueState {
  const phase = phaseOfLegacy(stage);
  if (phase === 'available') return { kind: 'available' };
  if (branch === 'cancelled') return { kind: 'cancelled', at: phase };
  if (branch === 'paused') return { kind: 'paused', resume: phase, problem: reason ?? null };
  if (branch === 'waiting') return { kind: 'waiting', outcome: outcomeOf(reason?.code) };
  if (reason) return { kind: 'blocked', at: phase as Exclude<Phase, 'available'>, problem: reason };
  return { kind: phase };
}

function migrateEntry(entry: LegacyEntry) {
  const legacy = entry.state === undefined;
  if (legacy) {
    const stage = entry.stage;
    const branch = entry.branch === 'attention' ? null : entry.branch;
    entry.state = stateOf(stage, branch, entry.reason);
    const since = entry.stageSince ?? entry.history?.at(-1)?.at ?? entry.createdAt;
    entry.stateSince = since;
    entry.phaseSince = since;
  } else {
    entry.state = stateOfPhase(entry.state);
  }
  // A history event stores the state of its moment. An old event keeps the meaning that its stage and its branch give.
  for (const event of entry.history ?? []) {
    if (event.state === undefined) {
      const stored = event as StoredEvent;
      const branch = stored.branch === 'attention' ? null : stored.branch;
      stored.state = stateOf(stored.stage, branch, null);
      stored.stage = phaseOf(stored.state);
      delete stored.branch;
      continue;
    }
    event.state = stateOfPhase(event.state);
    event.stage = phaseOfState(event.state);
  }
  entry.stateSince ??= entry.createdAt;
  entry.phaseSince ??= entry.stateSince;
  delete entry.stage;
  delete entry.branch;
  delete entry.reason;
  delete entry.stageSince;
}

// A pure migration of the queue data. It is idempotent, and it calls no hook, client, or webhook.
export function migrateQueue(queue: Record<string, QueueEntry>) {
  for (const entry of Object.values(queue)) migrateEntry(entry as LegacyEntry);
}

function withoutEmptySearchBlock(state: QueueState): QueueState {
  if (state.kind === 'blocked' && state.at === 'searching' && state.problem.code === 'no_results') return { kind: 'waiting', outcome: 'no_results' };
  if (state.kind === 'paused' && state.resume === 'searching' && state.problem?.code === 'no_results') return { kind: 'paused', resume: 'queued', problem: null };
  return state;
}

// An older version stopped a season and kept the releases that it chose for a part of the episodes.
export function migrateStoppedSeason(data: Data, item: QueueTurn) {
  const { state, search } = item;
  if (item.season === null || !search || state.kind !== 'blocked' || !['queued', 'searching', 'fetching'].includes(state.at) ||
    !['pack_partial', 'all_rejected', 'no_results'].includes(state.problem.code)) return;
  const { entries, rows } = detach(data, item);
  if (!rows.length) return;
  search.rejected = [...new Map([...search.rejected, ...rows].map((row) => [`${row.indexerId}:${row.guid}`, row])).values()];
  const now = Date.now();
  item.revision = ++data.queueRev;
  for (const entry of entries) {
    entry.state = entry.state.kind === 'paused' ? { kind: 'paused', resume: state.at, problem: state.problem } : { ...state };
    entry.stateSince = entry.phaseSince = now;
    entry.revision = ++data.queueRev;
  }
}

export function migrateEmptySeason(data: Data, item: QueueTurn) {
  // A stopped season whose found releases went to the rejected list had coverage when it stopped.
  if (item.season === null || !Object.keys(item.emptySearches).length || seasonHasCoverage(data, item) ||
    item.search?.rejected.some(({ manifestProblem }) => manifestProblem === 'pack_partial')) return;
  item.emptySearches = {};
  item.lastEmptyRound = null;
  const now = Date.now();
  const state = withoutEmptySearchBlock(item.state);
  if (state !== item.state) {
    item.state = state;
    item.stateSince = item.nextAt = now;
    if (item.search) item.search.nextAt = now;
    item.revision = ++data.queueRev;
  }
  for (const id of item.entryIds) {
    const entry = data.queue[id]!;
    delete entry.emptyRoundIndexers;
    const state = withoutEmptySearchBlock(entry.state);
    if (state === entry.state) continue;
    entry.state = state;
    entry.stateSince = entry.phaseSince = now;
    if (entry.search) entry.search.nextAt = now;
    entry.revision = ++data.queueRev;
  }
}

function cachedSource(data: Data, entry: QueueEntry, hash: string | null) {
  if (entry.source && 'magnet' in entry.source) return entry.source;
  if (hash && entry.source && data.torrents[hash]) return entry.source;
  return null;
}

function recoverEntry(data: Data, entry: QueueEntry, journal?: ImportJournal) {
  const original = entry.state;
  const phase = phaseOf(original);
  const hold = (original.kind === 'blocked' || original.kind === 'paused') && original.problem?.code === 'client_missing';
  const hash = journal?.hash ?? entry.transferHash ?? entry.release?.infoHash ?? null;
  const clientId = journal?.clientId ?? entry.clientId ?? null;
  const accepted = Boolean(hash && clientId && (journal || phase === 'downloading' || phase === 'importing' || entry.importResult?.ok));
  const source = cachedSource(data, entry, hash);
  const upload = Boolean(entry.release?.uploadPath);
  const uncertain = !accepted && Boolean(hash && clientId && (phase === 'sending' || (hold && data.sentTorrents[hash!])));
  const hasRelease = Boolean(entry.release);
  const numberingRevision = entry.season === null ? null : entry.numbering?.revision ?? null;
  const currentRevision = entry.season === null ? null : data.titles[entry.titleKey]?.numbering?.revision ?? 0;
  const prepared = !accepted && !uncertain && numberingRevision === currentRevision && Boolean(source && (phase === 'waiting_slot' || phase === 'sending'));
  const status: QueueTorrent['status'] = accepted ? 'accepted' : uncertain ? 'uncertain' : prepared ? 'prepared' : 'verify';
  let state = original;
  if (original.kind !== 'available' && original.kind !== 'cancelled') {
    let resume: Phase = phase;
    if (accepted && journal) resume = 'importing';
    else if (accepted && phase === 'sending') resume = 'downloading';
    else if (!upload && (phase === 'waiting_slot' || phase === 'sending' || (hold && hasRelease && !accepted))) resume = 'fetching';
    if (original.kind === 'paused') state = { kind: 'paused', resume, problem: hold ? null : original.problem };
    else if (original.kind === 'blocked' && !hold) state = { ...original, at: resume as WorkPhase };
    else if (hold || resume !== phase) state = { kind: resume };
  }
  entry.state = state;
  if (accepted) {
    entry.transferHash = hash;
    entry.clientId = clientId;
  } else if (!uncertain && !upload && state.kind !== 'available' && state.kind !== 'cancelled') {
    // The old fetch assigned a client before the add. This assignment does not identify a transfer.
    entry.clientId = null;
  }
  return { hash, clientId: accepted || uncertain ? clientId : null, state, hold, status, numberingRevision, source: accepted ? null : source };
}

// Legacy targets can disagree. This rule selects the next operation once, not on every queue read.
const MIGRATION_ORDER = ['fetching', 'searching', 'queued', 'waiting', 'downloading', 'importing', 'sending', 'waiting_slot', 'blocked', 'paused', 'available', 'cancelled'];

function recoverJobs(data: Data) {
  const searches = new Map<string, Job>();
  for (const job of Object.values(data.jobs).sort((a, b) => a.runAt - b.runAt || a.seq - b.seq)) {
    if (job.type === 'queue.search') {
      if (job.state === 'failed') continue;
      const payload = job.payload as SearchPayload | null;
      const item = payload && data.queueItems[itemId(payload.titleKey, payload.season)];
      if (!item || !['queued', 'searching', 'waiting'].includes(item.state.kind)) {
        delete data.jobs[job.id];
        continue;
      }
      const ids = (payload.entryIds ?? []).filter((id) => item.entryIds.includes(id) && ['queued', 'searching', 'waiting'].includes(data.queue[id]?.state.kind ?? ''));
      if (!ids.length) {
        delete data.jobs[job.id];
        continue;
      }
      const mode = JSON.stringify([item.id, Boolean(payload.manual), Boolean(payload.otherSeasons)]);
      const existing = searches.get(mode);
      if (existing) {
        const previous = existing.payload as SearchPayload;
        if (ids.some((id) => !previous.entryIds.includes(id))) previous.resume = undefined;
        previous.entryIds = [...new Set([...previous.entryIds, ...ids])];
        if (job.priority !== null) existing.priority = Math.min(existing.priority ?? Infinity, job.priority);
        delete data.jobs[job.id];
      } else {
        searches.set(mode, job);
        job.payload = { ...payload, entryIds: ids, itemId: item.id, resume: ids.length === payload.entryIds.length ? payload.resume : undefined };
      }
    } else if (job.type === 'queue.send' || job.type === 'queue.grab') {
      const payload = job.payload as { entryIds?: string[]; uploadHash?: string } | null;
      if (payload?.uploadHash) continue;
      // The item retains the source. The item sweep schedules its next operation.
      delete data.jobs[job.id];
    }
  }
}

export function migrateTurns(data: Data) {
  const groups = new Map<string, QueueEntry[]>();
  for (const entry of Object.values(data.queue)) {
    if (!data.titles[entry.titleKey]) continue;
    const id = itemId(entry.titleKey, entry.season);
    const group = groups.get(id);
    if (group) group.push(entry);
    else groups.set(id, [entry]);
  }
  const searchOrder = new Map<string, number>();
  for (const job of Object.values(data.jobs)) {
    if (job.type !== 'queue.search' || job.state === 'failed') continue;
    const payload = job.payload as SearchPayload | null;
    if (!payload?.titleKey) continue;
    const id = itemId(payload.titleKey, payload.season);
    searchOrder.set(id, Math.min(searchOrder.get(id) ?? Infinity, job.seq));
  }
  const journals = new Map<string, ImportJournal>();
  for (const journal of Object.values(data.imports)) {
    if (journal.sourceBase || journal.kind === 'rename') continue;
    for (const step of journal.steps) for (const id of step.entryIds) journals.set(id, journal);
  }
  const ordered = [...groups].sort(([a, aEntries], [b, bEntries]) => {
    const aTime = Math.min(...aEntries.map((entry) => entry.createdAt));
    const bTime = Math.min(...bEntries.map((entry) => entry.createdAt));
    return aTime - bTime || (searchOrder.get(a) ?? Infinity) - (searchOrder.get(b) ?? Infinity);
  });
  for (const [id, entries] of ordered) {
    if (data.queueItems[id]) continue;
    const first = entries[0]!;
    const item = newTurn(first.titleKey, first.season, data.queueItemSeq++, Math.min(...entries.map((entry) => entry.createdAt)));
    item.entryIds = entries.map((entry) => entry.id);
    item.revision = Math.max(...entries.map((entry) => entry.revision));
    item.priority = entries.reduce<number | null>((priority, entry) => entry.priority === null ? priority : Math.min(priority ?? Infinity, entry.priority), null);
    const recovered = entries.map((entry) => ({ entry, ...recoverEntry(data, entry, journals.get(entry.id)) }));
    const live = new Map(recovered.flatMap((target) => target.status === 'accepted' && target.hash && target.clientId &&
      (target.state.kind === 'downloading' || target.state.kind === 'importing') ? [[target.hash, target.clientId] as const] : []));
    for (const target of recovered) {
      const clientId = target.hash && live.get(target.hash);
      if (!clientId || target.status !== 'prepared' || target.state.kind !== 'fetching') continue;
      target.status = 'accepted';
      target.clientId = target.entry.clientId = clientId;
      target.entry.transferHash = target.hash;
      target.source = null;
      target.state = target.entry.state = { kind: 'downloading' };
    }
    const active = recovered.filter(({ state }) => isActiveState(state));
    const lead = (active.length ? active : recovered).reduce((a, b) => MIGRATION_ORDER.indexOf(a.state.kind) <= MIGRATION_ORDER.indexOf(b.state.kind) ? a : b);
    item.state = lead.state;
    item.stateSince = lead.entry.stateSince;
    item.clientHold = lead.hold;
    const searches = entries.flatMap(({ search, state }) => search && isActiveState(state) ? [search] : []).sort((a, b) => b.at - a.at);
    item.search = searches[0] ?? null;
    if (item.state.kind === 'waiting' || (item.state.kind === 'paused' && item.state.resume === 'queued')) {
      item.nextAt = active.reduce<number | null>((due, { entry, state }) => {
        const time = entry.search?.nextAt;
        return (state.kind === 'waiting' || state.kind === 'paused') && time != null ? Math.min(due ?? Infinity, time) : due;
      }, null);
    }
    for (const { entry, hash, clientId, status, source, state, numberingRevision } of recovered) {
      if (!entry.release || state.kind === 'cancelled' || (active.length && state.kind === 'available') || (entry.release.uploadPath && status !== 'accepted')) continue;
      if (status === 'verify') {
        if (state.kind === 'fetching' || state.kind === 'paused' || (state.kind === 'blocked' && state.at === 'fetching')) item.candidate ??= entry.release;
        if (!hash || !source) continue;
      }
      if (!hash) continue;
      const torrent = item.selected[hash] ??= {
        hash, release: entry.release, status, source, clientId,
        numberingRevision, matches: {},
      };
      const rank = ['verify', 'prepared', 'uncertain', 'accepted'];
      if (status === 'verify' && torrent.status !== 'verify') continue;
      if (rank.indexOf(status) > rank.indexOf(torrent.status)) {
        if (torrent.status === 'verify') torrent.matches = {};
        Object.assign(torrent, { status, source, clientId });
      }
      torrent.matches[entry.id] = entry.manualMatch?.file ?? null;
    }
    data.queueItems[id] = item;
  }
  recoverJobs(data);
}
