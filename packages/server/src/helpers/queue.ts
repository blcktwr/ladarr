import { qualityLabel } from '../library/grab/quality.ts';
import { parseRelease } from '../library/grab/release.ts';
import { manualRejection, REJECTION_TEXT } from '../library/grab/decide.ts';
import { aggregate, describe, itemId, needsOtherSeasons, phaseOf, type Problem as StateProblem, type Status, type Tab } from '@ladarr/shared/queue';
import { createHash } from 'node:crypto';
import type { QueueGroupRow, QueuePage, QueueRejectedRelease, QueueResolution, QueueRow, QueueSelection } from '@ladarr/shared/types';
import { normalizeNumbering, releasePoint, seasonRevision } from '../library/numbering.ts';
import { db } from '../core/db.ts';
import { redact } from '../core/log.ts';
import { reasonInfo, type ReasonScope } from '../core/reasons.ts';
import { availability } from '../library/library.ts';
import { acceptedPath } from '../library/downloads/file-evidence.ts';
import { findItem, getItem, isActive, itemFor, phaseOfEntry, reasonOfEntry } from '../library/downloads/queue.ts';
import type { Filters, Finder, ImportStatus, Job, Poller, QueueEntry, QueueTurn, ReasonInfo, RejectedRelease, ReleaseRef, RowGroup, SearchState, Title, Transfer } from '../types.ts';

export const DAY_MS = 24 * 60 * 60_000;
export const MAX_PAGE = 200;

// The place of a phase in the journey, from the least to the most advanced.
export const STAGE_ORDER = ['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing', 'available'] as const;
export const STAGE_RANK = new Map(STAGE_ORDER.map((stage, index) => [stage, index]));
// A target that waits for its next search or fetches its release ranks with the search. One that found nothing ranks
// where it waits, because only a new release moves it.
function progressOfState(state: QueueEntry['state']) {
  const description = describe(state);
  const { status } = description;
  const phase = status === 'searching' || status === 'fetching' ? 'searching' : status === 'not_found' || status === 'no_match' ? 'queued' : description.phase;
  return STAGE_RANK.get(phase)!;
}

export const progressOf = (entry: QueueEntry) => progressOfState(entry.state);

export const pad = (n: number) => String(n).padStart(2, '0');

// The jobs that move a target through the download flow. The jobs page shows only these.
const ITEM_JOB_TYPES = new Set(['queue.initial', 'queue.search', 'queue.grab', 'queue.send', 'import.run']);
export const isItemJob = (job: Job) => job.type.startsWith('item.') || ITEM_JOB_TYPES.has(job.type);

// The targets of a group that finished each stage, for the line under its status.
export function reachedOf(entries: QueueEntry[], poller: Poller) {
  const reached = { found: 0, matched: 0, completed: 0, validated: 0, imported: 0 };
  for (const entry of entries) {
    const phase = phaseOfEntry(entry);
    if (entry.release) reached.found++;
    const hash = entry.transferHash;
    const selection = hash ? itemFor(entry)?.selected[hash] : undefined;
    if (entry.state.kind === 'available'
      || (selection && selection.status !== 'verify' && selection.matches[entry.id])
      || entry.manualMatch?.covers.some(({ season, number }) => season === entry.season && number === entry.number)
      || (hash && poller.transfer(hash)?.entryFiles?.[entry.id])
      || importOf(undefined, entry)) reached.matched++;
    if (phase === 'importing' || phase === 'available') {
      reached.completed++;
      reached.validated++;
    }
    if (phase === 'available') reached.imported++;
  }
  return reached;
}

// The status of one target. The pages and the counters read it, and no caller derives it again.
export const statusOf = (entry: QueueEntry): Status => describe(entry.state).status;
export const tabOf = (entry: QueueEntry): Tab | null => describe(entry.state).tab;

// The problem of a stuck target, or the result of the search that keeps it waiting. A target that moves has none.
export function problemOf(entry: QueueEntry): StateProblem | null {
  const problem = reasonOfEntry(entry);
  if (problem?.code === 'pack_partial' && entry.state.kind === 'blocked' &&
    (entry.state.at === 'downloading' || entry.state.at === 'importing') && acceptedPath(entry)) {
    return { ...problem, code: 'file_not_found' };
  }
  return problem;
}

export function reasonOf(entry: QueueEntry): (ReasonInfo & { code: string; detail: string | null }) | null {
  const problem = problemOf(entry);
  if (!problem) return null;
  const specific = infoOfProblem(problem, entry.state.kind === 'blocked', entry.season === null ? 'movie' : 'episode');
  return { code: problem.code, ...specific, detail: problem.detail ?? null };
}

function infoOfProblem(problem: StateProblem, stopped: boolean, scope: ReasonScope): ReasonInfo {
  if (stopped && problem.code === 'no_results') return { message: 'The searches found no release.', action: 'retry' };
  return reasonInfo(problem.code === 'too_many_attempts' && problem.detail ? problem.detail : problem.code, scope);
}

export const reasonOfProblem = (problem: StateProblem | null, stopped = true, phase?: string) => {
  if (!problem) return null;
  const info = infoOfProblem(problem, stopped, 'group');
  const message = stopped && phase === 'fetching' && problem.code === 'file_unmapped' ? REJECTION_TEXT.file_unmapped! : info.message;
  return { code: problem.code, message, action: info.action, settings: info.settings ?? null, detail: problem.detail ?? null };
};

const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export function resolutionVersion(scope: unknown, state: unknown): string {
  return Buffer.from(JSON.stringify({ scope: digest(scope), state: digest(state) })).toString('base64url');
}

export function resolutionCurrent(version: unknown, scope: unknown, state?: unknown): boolean {
  if (typeof version !== 'string') return false;
  try {
    const saved = JSON.parse(Buffer.from(version, 'base64url').toString()) as { scope: string; state: string };
    return saved.scope === digest(scope) && (state === undefined || saved.state === digest(state));
  } catch {
    return false;
  }
}

export function associationState(titleKey: string) {
  const title = db.data.titles[titleKey]!;
  return {
    numbering: normalizeNumbering(title.numbering),
    episodes: title.episodes.map(({ season, number, fileId }) => ({ season, number, fileId })),
    fileId: title.fileId,
    files: Object.values(db.data.files).filter((file) => file.titleKey === titleKey).sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function catalogTargets(title: Title) {
  return title.episodes
    .map((episode) => ({
      id: `${title.key}:${episode.season}x${episode.number}`,
      label: `${title.meta.title} S${pad(episode.season)}E${pad(episode.number)}`,
      season: episode.season,
      number: episode.number,
    }))
    .sort((a, b) => a.season - b.season || a.number - b.number);
}

export function actionsOf(entries: QueueEntry[]): QueueResolution[] {
  const result = new Map<string, QueueResolution>();
  for (const entry of entries) {
    if (entry.state.kind !== 'blocked') continue;
    const problem = problemOf(entry)!;
    const cause = problem.code === 'too_many_attempts' && problem.detail ? problem.detail : problem.code;
    const phase = entry.state.at;
    const source = entry.transferHash ?? (cause === 'pack_partial' ? problem.detail : null) ?? entry.release?.title ?? entry.manualMatch?.file ?? null;
    const add = (action: QueueResolution['action'], text: string, settings?: string, fileSource?: QueueResolution['fileSource']) => {
      const key = JSON.stringify([action, phase, cause, problem.detail, source, settings, fileSource]);
      const item = result.get(key) ?? { action, label: text, ids: [], phase, cause, source, ...(settings ? { settings } : {}), ...(fileSource ? { fileSource } : {}) };
      item.ids.push(entry.id);
      result.set(key, item);
    };
    const title = titleOf(entry);
    // A series that a search stopped takes its releases by hand from the rejected list.
    const mappable = title?.mediaType === 'tv' && (['pack_partial', 'numbering_required'].includes(cause) ||
      (['no_results', 'all_rejected'].includes(cause) && rejectedOf(entry).length > 0));
    if (['file_not_found', 'file_unmapped', 'coverage_unknown', 'file_unreadable', 'file_invalid', 'destination_exists'].includes(cause) || mappable) {
      add('match', title?.mediaType === 'movie' ? 'Select file' : 'Map episodes manually', undefined, entry.transferHash ? 'download' : 'library');
    }
    if (cause === 'destination_exists') {
      add('use_existing', 'Use existing file', undefined, 'library');
      add('replace', 'Replace file');
    }
    if (phase === 'fetching' && entry.release && !['pack_partial', 'numbering_required', 'torrent_exists', 'file_invalid'].includes(cause)) add('retry_fetch', 'Retry fetch');
    if ((phase === 'sending' || phase === 'waiting_slot') && entry.release && cause !== 'file_invalid') add('retry_send', 'Retry send');
    if (['torrent_missing', 'client_error', 'client_unreachable'].includes(cause) && entry.transferHash) add('check_download', 'Check download');
    if (phase === 'importing' && !['pack_partial', 'numbering_required', 'file_unmapped', 'coverage_unknown', 'file_unreadable', 'file_invalid'].includes(cause)) add('retry_import', 'Retry import');
    if ((phase === 'queued' || phase === 'searching') && !['pack_partial', 'numbering_required', 'file_invalid'].includes(cause)) add('retry', 'Retry');
    const settings = reasonInfo(cause).settings;
    if (settings) add('settings', 'Settings', settings);
  }
  return [...result.values()];
}

// The title whose first search waits for its episodes. A series has a target for each episode, so it has none until
// the episodes arrive. The queue shows one pending row for the series meanwhile.
export function pendingTitleKeys() {
  const keys = new Set<string>();
  for (const job of Object.values(db.data.jobs)) {
    // A job that waits or runs can still be loading the episodes of a title that has no target yet.
    if (job.type !== 'queue.initial' || (job.state !== 'waiting' && job.state !== 'running')) continue;
    const key = (job.payload as { key?: unknown } | null)?.key;
    if (typeof key === 'string') keys.add(key);
  }
  for (const key of [...keys]) {
    const title = db.data.titles[key];
    const target = Object.values(db.data.queue).some((entry) => entry.titleKey === key && shown(entry) && !entry.clearedAt);
    if (!title || title.mediaType !== 'tv' || title.paused || target) keys.delete(key);
  }
  return keys;
}

// A search that waits for its next run is future work only while one of its targets still waits. A target that
// finished, stopped, or paused leaves no future search behind.
export const showsSearch = (job: Job) => {
  if (job.type !== 'queue.search' || job.state !== 'waiting') return true;
  const item = jobItem(job);
  if (item) return ['queued', 'waiting', 'searching', 'fetching'].includes(item.state.kind) && !db.data.titles[item.titleKey]?.paused;
  if (job.runAt <= Date.now()) return true;
  const payload = job.payload as { entryIds?: string[] } | null;
  return Boolean(
    payload?.entryIds?.some((id) => {
      const entry = db.data.queue[id];
      const title = entry ? db.data.titles[entry.titleKey] : undefined;
      return entry?.state.kind === 'waiting' && Boolean(title && !title.paused);
    }),
  );
};

export const titleOf = (entry: QueueEntry): Title | undefined => db.data.titles[entry.titleKey];
export const shown = (entry: QueueEntry) => Boolean(titleOf(entry)) && (entry.attempt > 0 || Boolean(itemFor(entry)?.entryIds.includes(entry.id)));
export const titleName = (title: Title) => `${title.meta.title}${title.meta.year ? ` (${title.meta.year})` : ''}`;

export function queueEpisode(entry: QueueEntry) {
  if (entry.season === null || entry.number === null) return null;
  const point = { season: entry.season, number: entry.number };
  return releasePoint(normalizeNumbering(titleOf(entry)?.numbering), point) ?? point;
}

export function label(entry: QueueEntry) {
  const title = titleOf(entry)!;
  const point = queueEpisode(entry);
  return point ? `${title.meta.title} S${pad(point.season)}E${pad(point.number)}` : titleName(title);
}

// The target of a job. A job without a target has no entry.
function jobItem(job: Job) {
  const payload = job.payload as { itemId?: string; titleKey?: string; season?: number | null; entryIds?: string[] } | null;
  if (payload?.itemId) return getItem(payload.itemId);
  const entry = payload?.entryIds?.map((id) => db.data.queue[id]).find(Boolean);
  if (entry) return itemFor(entry);
  if (job.type === 'queue.search' && payload?.titleKey && payload.season !== undefined) return findItem(payload.titleKey, payload.season);
  return undefined;
}

export function jobEntry(job: Job): QueueEntry | undefined {
  const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
  const targets = payload?.entryIds?.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry)) ?? [];
  // A future search names a target that still waits, not one that its payload kept after the target moved on.
  const first = job.type === 'queue.search' && job.state === 'waiting' ? (targets.find((entry) => entry.state.kind === 'waiting') ?? targets[0]) : targets[0];
  if (first) return first;
  const item = jobItem(job);
  if (item) return item.entryIds.map((id) => db.data.queue[id]).find(Boolean);
  if (payload?.hash) return Object.values(db.data.queue).find((entry) => entry.transferHash === payload.hash);
  return undefined;
}

// The title of a job. A job without a target can still name the title of its key.
export function jobTitle(job: Job): Title | undefined {
  const entry = jobEntry(job);
  if (entry && titleOf(entry)) return titleOf(entry);
  const payload = job.payload as { key?: string; titleKey?: string } | null;
  const key = payload?.key ?? payload?.titleKey;
  return key ? db.data.titles[key] : undefined;
}

// The target of a job, as the queue names it. A job without a target has no label.
export function jobLabel(job: Job): string | null {
  const entry = jobEntry(job);
  const title = jobTitle(job);
  if (title && (job.type.startsWith('item.') || ['queue.search', 'queue.grab', 'queue.send'].includes(job.type))) {
    const season = jobItem(job)?.season ?? entry?.season ?? null;
    return season === null ? titleName(title) : `${titleName(title)} S${pad(season)}`;
  }
  if (entry && titleOf(entry)) return label(entry);
  return title ? titleName(title) : null;
}

// The jobs of the item flow that run now or wait for the worker, in the order that the page shows them. A running
// job comes first, because it is the current work of the Activity page. Then the waiting jobs follow in the order
// that the worker starts them.
export function itemJobs() {
  const now = Date.now();
  const list = Object.values(db.data.jobs)
    .filter((job) => (job.state === 'waiting' || job.state === 'running') && isItemJob(job) && showsSearch(job))
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
      if (a.priority !== null || b.priority !== null) {
        if (a.priority === null) return 1;
        if (b.priority === null) return -1;
        return a.priority - b.priority;
      }
      return a.runAt - b.runAt || a.seq - b.seq;
    });
  const turns = list.flatMap((job, index) => {
    if (job.state !== 'waiting' || job.type !== 'queue.search' || job.runAt > now) return [];
    const item = jobItem(job);
    return item && (item.nextAt ?? 0) <= now ? [{ job, index, item }] : [];
  });
  const ordered = [...turns].sort((a, b) => (a.item.priority ?? a.job.priority ?? Infinity) - (b.item.priority ?? b.job.priority ?? Infinity)
    || a.item.position - b.item.position || a.job.seq - b.job.seq);
  turns.forEach(({ index }, position) => { list[index] = ordered[position]!.job; });
  return list;
}

// The next request that the indexers of a job can take. A job that does not touch an indexer has no wait.
export function indexerWaitOf(finder: Finder, job: Job): number {
  const payload = job.payload as { titleKey?: string; entryIds?: string[] } | null;
  if (job.type === 'queue.search') {
    const title = payload?.titleKey ? db.data.titles[payload.titleKey] : undefined;
    if (!title) return 0;
    return finder.usableIndexers(title).reduce((latest, indexer) => Math.max(latest, indexer.nextRequestAt), 0);
  }
  if (job.type === 'queue.grab') {
    const entry = payload?.entryIds?.map((id) => db.data.queue[id]).find(Boolean);
    // A magnet needs no request to the indexer, so only a release with a link waits for it.
    const indexer = entry?.release?.link ? db.data.indexers[entry.release.indexerId] : undefined;
    return indexer?.nextRequestAt ?? 0;
  }
  return 0;
}

export const jobEta = (finder: Finder, job: Job) => Math.max(job.runAt, Date.now(), job.type === 'queue.search' ? jobItem(job)?.nextAt ?? 0 : 0, indexerWaitOf(finder, job));

export function lanePositions() {
  const lane = Object.values(db.data.queue).filter((entry) => entry.priority !== null && isActive(entry) && entry.attempt > 0);
  lane.sort((a, b) => a.priority! - b.priority!);
  return new Map(lane.map((entry, index) => [entry.id, index + 1]));
}

// The step of the import journal for an entry. The hard link or copy and the step are separate from the bytes of a copy.
export function importOf(importStatus: ImportStatus | undefined, entry: QueueEntry) {
  if (phaseOfEntry(entry) !== 'importing') return null;
  for (const journal of Object.values(db.data.imports)) {
    const step = journal.steps.find((item) => item.entryIds.includes(entry.id));
    if (!step) continue;
    const copy = importStatus?.copyOfStep(journal.id, step.dest);
    return { state: step.state, method: step.method, copy: copy ? { copiedBytes: copy.copiedBytes, totalBytes: copy.totalBytes, observedAt: copy.observedAt } : null };
  }
  return null;
}

// The file of a target: the file of its open import, its file in the client, or its record in the library.
export function fileOf(entry: QueueEntry, title: Title, transfer?: Transfer) {
  for (const journal of Object.values(db.data.imports)) {
    const step = journal.steps.find((item) => item.entryIds.includes(entry.id));
    if (step) return { name: step.source.split('/').at(-1)!, sizeBytes: step.sizeBytes };
  }
  const downloading = transfer?.entryFiles?.[entry.id];
  if (downloading) return downloading;
  const episode = entry.season === null ? undefined : title.episodes.find((e) => e.season === entry.season && e.number === entry.number);
  const file = db.data.files[(entry.season === null ? title.fileId : episode?.fileId) ?? ''];
  return file ? { name: file.path.split('/').at(-1)!, sizeBytes: file.sizeBytes } : null;
}

// The text of a reason that a search of an older version kept, when the text changed since then.
const RENAMED_REASONS: Record<string, string> = {
  'The quality of the release is not in any quality profile of the title.': REJECTION_TEXT.quality_not_in_profile!,
  'The torrent files do not contain all the requested episodes.': REJECTION_TEXT.file_unmapped!,
};
const currentText = (text: string) => RENAMED_REASONS[text] ?? text;
const manualStops = Object.entries(REJECTION_TEXT).filter(([code]) => manualRejection(code));

// The reasons of a release that the search rejected.
export const rejectedId = (release: Pick<RejectedRelease, 'indexerId' | 'guid'>) => digest([release.indexerId, release.guid]);

function publicRejectionId(entry: QueueEntry, release: RejectedRelease) {
  return release.guid === release.title && /^[\p{L}\p{N}][\p{L}\p{N} ._'()-]*$/u.test(release.guid)
    ? release.guid
    : digest([itemId(entry.titleKey, entry.season), release.indexerId, release.guid]);
}

export function manualStopsOf(release: RejectedRelease) {
  const reasons = (release.reasons ?? []).map(currentText);
  return manualStops.filter(([code]) => code !== 'file_unmapped' || release.kind !== 'pack')
    .flatMap(([code, message]) => reasons.includes(code) || reasons.includes(message) ? [{ code, message }] : []);
}

function rejectedView(entry: QueueEntry, release: RejectedRelease): QueueRejectedRelease {
  const reasons = (release.reasons ?? []).map(currentText);
  return {
    indexerId: release.indexerId,
    guid: publicRejectionId(entry, release),
    title: release.title,
    sizeBytes: release.sizeBytes,
    seeders: release.seeders,
    resolution: release.resolution,
    source: release.source,
    kind: release.kind,
    reasons,
    selectable: !manualStopsOf(release).length,
    ...(release.matches ? { matches: release.matches } : {}),
    sizeRejection: release.sizeRejection,
  };
}

export function rejectedOf(entry: QueueEntry) {
  const item = itemFor(entry);
  if (!item) return entry.search?.rejected ?? [];
  return item.entryIds.includes(entry.id) ? item.search?.rejected ?? [] : [];
}

export function findRejected(entry: QueueEntry, indexerId: number, guid: string) {
  return rejectedOf(entry).find((release) => release.indexerId === indexerId && publicRejectionId(entry, release) === guid);
}

function searchView(entry: QueueEntry, search: SearchState | null, nextAt?: number | null) {
  return search ? {
    ...search,
    indexers: search.indexers.map((indexer) => indexer.error ? { ...indexer, error: publicText(indexer.error.replace(/\b(?:https?|ftp):\/\/[^\s"'<>]+/gi, '[redacted]')) } : indexer),
    nextAt: nextAt === undefined ? search.nextAt : nextAt,
    rejected: rejectedOf(entry).map((release) => rejectedView(entry, release)),
  } : null;
}

export function publicText(text: string, link?: string | null): string {
  const value = redact((link ? text.replaceAll(link, '[redacted]') : text).replace(/\bmagnet:\?[^\s"'<>]+/gi, '[redacted]'));
  return typeof value === 'string' ? value : JSON.stringify(value);
}

function releaseView(release: ReleaseRef) {
  const parsed = parseRelease(release.title);
  const quality = parsed.source !== 'unknown' || parsed.resolution !== null ? qualityLabel(parsed.source, parsed.resolution) : null;
  return { title: release.title, indexer: release.indexerName, sizeBytes: release.sizeBytes, kind: release.kind, manual: release.manual, comment: release.comment ? publicText(release.comment, release.link) : null, quality };
}

function torrentsOf(entries: QueueEntry[], item: QueueTurn | undefined): QueueSelection[] {
  const first = entries[0];
  if (!first) return [];
  const torrents = new Map<string, QueueSelection>();
  for (const selected of Object.values(item?.selected ?? {})) {
    torrents.set(selected.hash, {
      key: selected.hash,
      entryId: entries.find((entry) => Object.hasOwn(selected.matches, entry.id))?.id ?? first.id,
      hash: selected.hash,
      status: selected.status === 'accepted' ? 'accepted' : selected.status === 'verify' ? 'inspecting' : 'prepared',
      release: releaseView(selected.release),
    });
  }
  if (item?.state.kind === 'fetching' && item.candidate) {
    const candidate = item.candidate;
    const key = rejectedId(candidate);
    if (!(candidate.infoHash && torrents.has(candidate.infoHash)) && !Object.values(item.selected).some(({ release }) => rejectedId(release) === key)) {
      torrents.set(key, { key, entryId: first.id, hash: candidate.infoHash, status: 'inspecting', release: releaseView(candidate) });
    }
  }
  for (const entry of entries) {
    if (!entry.release || (item && !entry.transferHash)) continue;
    const hash = entry.transferHash ?? entry.release.infoHash;
    const key = hash ?? rejectedId(entry.release);
    if (!torrents.has(key)) {
      torrents.set(key, { key, entryId: entry.id, hash, status: entry.transferHash ? 'accepted' : 'inspecting', release: releaseView(entry.release) });
    }
  }
  return [...torrents.values()];
}

export function visibleState(entry: QueueEntry) {
  return entry.season === null && !entry.clearedAt ? itemFor(entry)?.state ?? entry.state : entry.state;
}

export function view(poller: Poller, importStatus: ImportStatus | undefined, entry: QueueEntry, lane: Map<string, number>, detail = false) {
  const title = titleOf(entry)!;
  const item = itemFor(entry);
  const movie = entry.season === null && !entry.clearedAt ? item : undefined;
  const state = visibleState(entry);
  const description = describe(state);
  const episode = entry.season === null ? undefined : title.episodes.find((e) => e.season === entry.season && e.number === entry.number);
  const transfer = entry.transferHash ? poller.transfer(entry.transferHash) : undefined;
  const info = reasonOf(state === entry.state ? entry : { ...entry, state });
  const torrents = movie ? torrentsOf([entry], movie) : undefined;
  const base = {
    id: entry.id,
    titleKey: entry.titleKey,
    mediaType: title.mediaType,
    title: title.meta.title,
    year: title.meta.year,
    posterPath: title.meta.posterPath,
    season: entry.season,
    number: entry.number,
    releaseEpisode: queueEpisode(entry),
    episodeName: episode?.name ?? null,
    label: label(entry),
    status: description.status,
    tab: description.tab,
    phase: description.phase,
    reason: info ? { code: info.code, message: info.message, action: info.action, settings: info.settings ?? null, detail: info.detail } : null,
    actions: actionsOf([entry]),
    stateSince: movie?.stateSince ?? entry.stateSince,
    revision: entry.revision,
    lane: lane.get(entry.id) ?? null,
    attempt: entry.attempt,
    completedAt: entry.completedAt,
    clearedAt: entry.clearedAt,
    release: torrents ? torrents[0]?.release ?? null : entry.release ? releaseView(entry.release) : null,
    ...(movie ? { torrents, position: movie.position, nextAt: movie.nextAt } : {}),
    file: fileOf(entry, title, transfer),
    // The client has a torrent for this target. An attached torrent is one that the user chose. ladarr did not add it.
    hasTorrent: Boolean(entry.transferHash),
    attached: Boolean(entry.release?.external),
    // The link and the magnet stay on the server: they carry the API key of the indexer.
    search: searchView(entry, movie ? movie.search ?? entry.search : entry.search ?? item?.search ?? null, item?.nextAt ?? (item?.state.kind === 'blocked' ? null : undefined)),
    // A pack gives one transfer to several entries. The numbers are the numbers of the torrent, and they count once.
    // The part of an episode comes from its own file when the client reports it.
    transfer: transfer
      ? {
          hash: transfer.hash,
          progress: transfer.entryProgress?.[entry.id] ?? (entry.number === null ? transfer.progress : null),
          sizeBytes: transfer.sizeBytes,
          downloadRate: transfer.downloadRate,
          etaSeconds: transfer.etaSeconds,
          status: transfer.status,
          observedAt: transfer.observedAt,
          stale: transfer.stale,
          shared: transfer.entryIds.length > 1,
          sharedWith: transfer.entryIds.length,
          seeds: transfer.seeds,
          peers: transfer.peers,
        }
      : null,
    importResult: entry.importResult ?? null,
    import: importOf(importStatus, entry),
    // The checks belong to the import of the target. A target outside Importing has none.
    checks: description.phase === 'importing' ? (importStatus?.checksOf(entry.id) ?? null) : null,
  };
  if (!detail) return base;
  return {
    ...base,
    history: entry.history,
    attempts: entry.attempts,
    manualMatch: entry.manualMatch,
  };
}

// A title whose release has not come, or whose episodes have not aired, is upcoming. Its bookmark shows a clock.
export const isUpcoming = (title: Title) => availability(title, { now: Date.now(), files: db.data.files }) === 'waiting';

export const filtersOf = (query: Record<string, unknown>): Filters => ({
  key: typeof query.stage === 'string' ? query.stage : undefined,
  type: typeof query.type === 'string' ? query.type : undefined,
  q: typeof query.q === 'string' && query.q.trim() ? query.q.trim().toLowerCase() : undefined,
  priority: query.priority === '1',
  cleared: query.cleared === '1',
});

export function matches(entry: QueueEntry, f: Filters) {
  if (!shown(entry)) return false;
  if (!f.cleared && entry.clearedAt) return false;
  if (f.key && tabOf(entry) !== f.key) return false;
  const title = titleOf(entry)!;
  if (f.type && title.mediaType !== f.type) return false;
  if (f.q && !title.meta.title.toLowerCase().includes(f.q)) return false;
  if (f.priority && (entry.priority === null || !isActive(entry))) return false;
  return true;
}

export const bySeasonNumber = (a: QueueEntry, b: QueueEntry) => (a.season ?? 0) - (b.season ?? 0) || (a.number ?? 0) - (b.number ?? 0);

const groupPriority = (group: RowGroup) => findItem(group.title.key, group.season)?.priority
  ?? Math.min(...group.entries.flatMap((entry) => entry.priority !== null && isActive(entry) ? [entry.priority] : []));
const positionOf = (group: RowGroup) => findItem(group.title.key, group.season)?.position ?? group.first;

// The rows of the queue, before the page and after the filters. The counters read the same rows, so a badge and the
// rows of its tab always agree.
function groupsOf(f: Filters, poller?: Poller): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  const entryFilters = { ...f, key: undefined, priority: false };
  for (const entry of Object.values(db.data.queue)) {
    if (!shown(entry) || (!f.cleared && entry.clearedAt)) continue;
    const title = titleOf(entry)!;
    const season = entry.season;
    const key = itemId(entry.titleKey, season);
    const group = groups.get(key) ?? {
      key,
      title,
      season,
      entries: [],
      matching: 0,
      first: entry.createdAt,
      progress: Number.POSITIVE_INFINITY,
      part: -1,
      download: -1,
      ready: false,
      searching: false,
      upcoming: isUpcoming(title),
      notFound: false,
      pending: false,
    };
    group.entries.push(entry);
    // A target that found no release waits for a new release, so its row goes after the rows that still have work.
    if (statusOf(entry) === 'not_found') group.notFound = true;
    if (matches(entry, entryFilters)) group.matching++;
    group.first = Math.min(group.first, entry.createdAt);
    // An available target is finished. It does not hold the group back.
    if (entry.state.kind !== 'available') group.progress = Math.min(group.progress, progressOf(entry));
    // A download that works: the client has a part of its file.
    if (entry.state.kind === 'downloading' && poller) {
      const transfer = entry.transferHash ? poller.transfer(entry.transferHash) : undefined;
      // The part of the least advanced file, for the order of the rows. A pack downloads its files one by one.
      const part = transfer?.entryProgress?.[entry.id] ?? (entry.number === null ? transfer?.progress ?? null : null);
      if (part !== null) group.part = group.part < 0 ? part : Math.min(group.part, part);
      // The bar of the group shows the part of the torrent that the client reports, as the client shows it.
      if (transfer) group.download = group.download < 0 ? transfer.progress : Math.min(group.download, transfer.progress);
    }
    // A target that has its release waits for a free slot of its client. Its row goes above the rows that only
    // search, because it is the target that takes the next slot.
    if (entry.state.kind === 'fetching' || entry.state.kind === 'waiting_slot') group.ready = true;
    // The search of a title runs now, so its row stays above the rows that wait for their next search.
    if (entry.state.kind === 'searching') group.searching = true;
    groups.set(key, group);
  }
  // A series that waits for its episodes has no target yet. One pending row shows it while its initial job runs.
  for (const key of pendingTitleKeys()) {
    const title = db.data.titles[key];
    if (!title) continue;
    const matching = !f.cleared && !f.priority && (!f.key || f.key === 'searching') && (!f.type || f.type === 'tv') && (!f.q || title.meta.title.toLowerCase().includes(f.q)) ? 1 : 0;
    if (!matching) continue;
    const group: RowGroup = {
      key,
      title,
      season: null,
      entries: [],
      matching,
      first: title.addedAt,
      progress: STAGE_RANK.get('searching')!,
      part: -1,
      download: -1,
      ready: false,
      searching: true,
      upcoming: isUpcoming(title),
      notFound: false,
      pending: true,
    };
    groups.set(key, group);
  }
  // A group with a target that found no release goes after every other row, because a new release is its only next
  // step. A title that waits for its release has no work yet, so its row goes after the rest.
  return [...groups.values()]
    .filter((group) => {
      if (group.pending) return true;
      const item = findItem(group.title.key, group.season);
      const description = item ? describe(item.state) : null;
      if (description) {
        group.progress = description.status === 'available' ? Infinity : progressOfState(item!.state);
        group.ready = description.status === 'fetching';
        group.searching = description.status === 'searching' && description.working;
        group.notFound = false;
      }
      const matching = f.priority ? Number.isFinite(groupPriority(group)) && (!description || description.active) : true;
      return matching && group.matching > 0 && Number.isFinite(group.progress) && (!f.key || (description ? description.tab === f.key : aggregateEntries(group.entries).tabs.some((tab) => tab === f.key)));
    })
    .sort(
      (a, b) =>
        (f.priority ? groupPriority(a) - groupPriority(b) : 0) ||
        (f.key === 'queued' ? 0
          : Number(a.notFound) - Number(b.notFound) ||
            Number(a.upcoming) - Number(b.upcoming) ||
            b.progress - a.progress ||
            b.part - a.part ||
            Number(b.ready) - Number(a.ready) ||
            Number(b.searching) - Number(a.searching)) ||
        positionOf(a) - positionOf(b) ||
        a.key.localeCompare(b.key),
    );
}

// The targets of a season that the manual search of the other seasons of the releases can take. A pack that held a part
// of the season stops them, and the search of the other seasons is the way out.
export const otherSeasonsTargets = (titleKey: string, season: number | null) =>
  Object.values(db.data.queue).filter(
    (entry) => entry.titleKey === titleKey && (season === null || entry.season === season) && shown(entry) &&
      needsOtherSeasons(entry.state) && problemOf(entry)?.code !== 'file_not_found',
  );

export function aggregateEntries(entries: QueueEntry[]) {
  const states = new Map<string, QueueEntry['state']>();
  for (const entry of entries) {
    const item = !entry.clearedAt ? itemFor(entry) : undefined;
    states.set(item?.id ?? entry.id, item?.state ?? entry.state);
  }
  return aggregate(states.values());
}

// The status belongs to the queue item. The counts describe its episodes.
export function groupAggregate(entries: QueueEntry[], item?: QueueTurn) {
  const first = entries[0];
  if (!item && first && entries.every((entry) => entry.season === first.season)) item = itemFor(first);
  const states = aggregate(entries.map((entry) => entry.state));
  const result = item ? states : aggregateEntries(entries);
  const description = item ? describe(item.state) : null;
  const status = description?.status ?? result.status;
  const rejected = new Map<string, { entryId: string; release: QueueRejectedRelease }>();
  if (status === 'stuck' || status === 'no_match') {
    const members = item ? entries.filter(({ id }) => item!.entryIds.includes(id)) : entries;
    const lead = members.find(({ state }) => state.kind === 'blocked') ?? members[0];
    const sources = item
      ? lead ? [{ entry: lead, releases: rejectedOf(lead) }] : []
      : entries.map((entry) => ({ entry, releases: rejectedOf(entry) }));
    for (const { entry, releases } of sources) {
      for (const release of releases) {
        const parsed = item ? parseRelease(release.title) : null;
        const target = parsed?.season == null ? entry : members.find((member) => {
          if (member.state.kind !== 'blocked') return false;
          const point = queueEpisode(member);
          return point?.season === parsed.season && (release.kind === 'pack' || parsed.episodes.includes(point.number));
        }) ?? entry;
        const view = rejectedView(target, release);
        const key = rejectedId(release);
        if (!rejected.has(key)) rejected.set(key, { entryId: target.id, release: view });
      }
    }
  }
  const actions = actionsOf(entries);
  const itemProblem = item && first ? reasonOfEntry({ ...first, state: item.state }) : result.problem;
  const missingFile = itemProblem?.code === 'pack_partial' && entries.some((entry) =>
    entry.state.kind === 'blocked' && entry.state.problem.code === 'pack_partial' && problemOf(entry)?.code === 'file_not_found');
  const problem = missingFile ? { ...itemProblem!, code: 'file_not_found' } : itemProblem;
  if (description?.status === 'stuck' && description.phase === 'fetching' && problem && ['file_unmapped', 'numbering_required'].includes(problem.code) && !actions.some((action) => action.action === 'match')) {
    actions.push({ action: 'match', label: 'Map episodes manually', ids: entries.map(({ id }) => id), phase: 'fetching', cause: problem.code, source: item?.candidate?.title ?? null });
  }
  return {
    status,
    counts: states.counts,
    tabs: description ? description.tab ? [description.tab] : [] : result.tabs,
    total: entries.length,
    problem: reasonOfProblem(problem, status === 'stuck', description?.phase),
    actions,
    otherSeasons: entries.filter((entry) => needsOtherSeasons(entry.state) && problemOf(entry)?.code !== 'file_not_found').length,
    torrents: torrentsOf(entries, item).filter(({ status }) => status !== 'inspecting'),
    rejected: [...rejected.values()],
    missing: status === 'stuck' && problem?.code === 'no_results' ? entries.flatMap(({ id, season, number }) => {
      const rounds = item?.emptySearches[id] ?? 0;
      const covered = Object.values(item?.selected ?? {}).some(({ status, matches }) => status !== 'verify' && Object.hasOwn(matches, id));
      return !covered && rounds >= 3 && season !== null && number !== null ? [{ season, number, rounds }] : [];
    }) : [],
    position: item?.position ?? null,
    nextAt: item?.nextAt ?? null,
  };
}

function groupRow(group: RowGroup, poller: Poller): QueueGroupRow {
  const summary = groupAggregate(group.entries, findItem(group.title.key, group.season));
  return {
    ...summary,
    kind: 'group',
    key: group.key,
    titleKey: group.entries[0]!.titleKey,
    title: group.title.meta.title,
    year: group.title.meta.year,
    posterPath: group.title.meta.posterPath,
    season: group.season,
    numberingRevision: seasonRevision(group.title.numbering, group.season),
    reached: reachedOf(group.entries, poller),
    download: group.download < 0 ? null : group.download,
    matching: group.matching,
    priority: Number.isFinite(groupPriority(group)),
  };
}

function groupRowOf(group: RowGroup, poller: Poller, importStatus: ImportStatus | undefined, lane: Map<string, number>): QueueRow {
  if (group.pending) {
    return { kind: 'pending', key: group.key, titleKey: group.key, title: group.title.meta.title, year: group.title.meta.year, posterPath: group.title.meta.posterPath, season: null, priority: false };
  }
  const first = group.entries[0]!;
  if (first.season === null) return { kind: 'entry', ...view(poller, importStatus, first, lane) };
  return groupRow(group, poller);
}

export function queuePage(poller: Poller, importStatus: ImportStatus | undefined, f: Filters, limit: number, offset: number): QueuePage {
  const lane = lanePositions();
  const rows = groupsOf(f, poller);
  return { cursor: db.data.queueRev, total: rows.length, items: rows.slice(offset, offset + limit).map((group) => groupRowOf(group, poller, importStatus, lane)) };
}

// The number of rows in each tab. A row counts only in the tab of its aggregate status.
export function queueTabCounts(): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const group of groupsOf(filtersOf({}))) {
    const item = findItem(group.title.key, group.season);
    const tab = item ? describe(item.state).tab : null;
    const tabs = group.pending ? ['searching' as Tab] : item ? tab ? [tab] : [] : aggregateEntries(group.entries).tabs;
    for (const tab of tabs) counts[tab] = (counts[tab] ?? 0) + 1;
  }
  return counts;
}

export function queueDescriptions() {
  const states = new Map<string, QueueEntry['state'][]>();
  let targets = 0;
  for (const entry of Object.values(db.data.queue)) {
    if (!shown(entry) || entry.clearedAt) continue;
    targets++;
    const key = itemId(entry.titleKey, entry.season);
    const item = itemFor(entry);
    if (item) states.set(key, [item.state]);
    else {
      const group = states.get(key);
      if (group) group.push(entry.state);
      else states.set(key, [entry.state]);
    }
  }
  const descriptions = [...states.values()].map((group) => {
    const { status } = aggregate(group);
    return describe(group.find((state) => describe(state).status === status)!);
  });
  return { descriptions, targets };
}

export { aggregate, describe, phaseOf };
