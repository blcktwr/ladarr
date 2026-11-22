import { qualityLabel } from '../library/grab/quality.ts';
import { parseRelease } from '../library/grab/release.ts';
import { REJECTION_TEXT } from '../library/grab/decide.ts';
import { aggregate, describe, needsOtherSeasons, phaseOf, type Problem as StateProblem, type Status, type Tab } from '@ladarr/shared/queue';
import { createHash } from 'node:crypto';
import type { QueueGroupRow, QueuePage, QueueResolution, QueueRow } from '@ladarr/shared/types';
import { normalizeNumbering, releasePoint } from '../library/numbering.ts';
import { db } from '../core/db.ts';
import { seasonOf } from '../core/jobs.ts';
import { reasonInfo } from '../core/reasons.ts';
import { availability } from '../library/library.ts';
import { isActive, phaseOfEntry, reasonOfEntry } from '../library/downloads/queue.ts';
import type { Db, Filters, Finder, ImportStatus, Job, Poller, QueueEntry, ReasonInfo, RowGroup, Title, Transfer } from '../types.ts';

export const DAY_MS = 24 * 60 * 60_000;
export const MAX_PAGE = 200;

// The place of a phase in the journey, from the least to the most advanced.
export const STAGE_ORDER = ['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing', 'available'] as const;
export const STAGE_RANK = new Map(STAGE_ORDER.map((stage, index) => [stage, index]));
// A target that waits for its next search or fetches its release ranks with the search. One that found nothing ranks
// where it waits, because only a new release moves it.
export const progressOf = (entry: QueueEntry) => {
  const status = statusOf(entry);
  const phase = status === 'searching' || status === 'fetching' ? 'searching' : status === 'not_found' || status === 'no_match' ? 'queued' : phaseOfEntry(entry);
  return STAGE_RANK.get(phase)!;
};

export const pad = (n: number) => String(n).padStart(2, '0');

// The jobs that move a target through the download flow. The jobs page shows only these.
const ITEM_JOB_TYPES = new Set(['queue.initial', 'queue.search', 'queue.grab', 'queue.send', 'import.run']);
export const isItemJob = (job: Job) => job.type.startsWith('item.') || ITEM_JOB_TYPES.has(job.type);

// The targets of a group that finished each stage, for the line under its status.
export function reachedOf(entries: QueueEntry[]) {
  const reached = { found: 0, completed: 0, validated: 0, imported: 0 };
  for (const entry of entries) {
    const phase = phaseOfEntry(entry);
    if (entry.release) reached.found++;
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
  return reasonOfEntry(entry);
}

export function reasonOf(entry: QueueEntry): (ReasonInfo & { code: string; detail: string | null }) | null {
  const problem = problemOf(entry);
  if (!problem) return null;
  const specific = problem.code === 'too_many_attempts' && problem.detail ? reasonInfo(problem.detail) : reasonInfo(problem.code);
  return { code: problem.code, ...specific, detail: problem.detail ?? null };
}
// The reason of a group, from the problem that aggregate() chose.
export const reasonOfProblem = (problem: StateProblem | null) => {
  if (!problem) return null;
  const info = reasonInfo(problem.code === 'too_many_attempts' && problem.detail ? problem.detail : problem.code);
  return { code: problem.code, message: info.message, action: info.action, settings: info.settings ?? null, detail: problem.detail ?? null };
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
    const problem = entry.state.problem;
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
    if (['file_not_found', 'file_unmapped', 'coverage_unknown', 'file_unreadable', 'file_invalid', 'destination_exists'].includes(cause) || (title?.mediaType === 'tv' && ['pack_partial', 'numbering_required'].includes(cause))) {
      add('match', title?.mediaType === 'movie' ? 'Select file' : 'Map episodes', undefined, entry.transferHash ? 'download' : 'library');
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
    const target = Object.values(db.data.queue).some((entry) => entry.titleKey === key && entry.attempt > 0 && !entry.clearedAt);
    if (!title || title.mediaType !== 'tv' || title.paused || target) keys.delete(key);
  }
  return keys;
}

// A search that waits for its next run is future work only while one of its targets still waits. A target that
// finished, stopped, or paused leaves no future search behind.
export const showsSearch = (job: Job) => {
  if (job.type !== 'queue.search' || job.state !== 'waiting' || job.runAt <= Date.now()) return true;
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
export const shown = (entry: QueueEntry) => entry.attempt > 0 && Boolean(titleOf(entry));
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
export function jobEntry(job: Job): QueueEntry | undefined {
  const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
  const targets = payload?.entryIds?.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry)) ?? [];
  // A future search names a target that still waits, not one that its payload kept after the target moved on.
  const first = job.type === 'queue.search' && job.state === 'waiting' ? (targets.find((entry) => entry.state.kind === 'waiting') ?? targets[0]) : targets[0];
  if (first) return first;
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
  const payload = job.payload as { titleKey?: string; season?: number | null; entryIds?: string[] } | null;
  // A search covers a whole season. Its label names the season, so the row does not look like one episode.
  if (job.type === 'queue.search' && typeof payload?.season === 'number' && (payload.entryIds?.length ?? 0) > 1) {
    const title = payload.titleKey ? db.data.titles[payload.titleKey] : undefined;
    if (title) {
      const seasons = new Set(payload.entryIds!.flatMap((id) => db.data.queue[id] ? queueEpisode(db.data.queue[id]!)?.season ?? [] : []));
      if (seasons.size > 1) return titleName(title);
      return `${titleName(title)} S${pad(seasons.values().next().value ?? payload.season)}`;
    }
  }
  const entry = jobEntry(job);
  if (entry && titleOf(entry)) return label(entry);
  const title = jobTitle(job);
  return title ? titleName(title) : null;
}

// The jobs of the item flow that run now or wait for the worker, in the order that the page shows them. A running
// job comes first, because it is the current work of the Activity page. Then the waiting jobs follow in the order
// that the worker starts them.
export function itemJobs() {
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
  // The searches of one series show from the first season up, as the worker starts them. A marked job keeps its place.
  const slots = new Map<string, number[]>();
  for (const [index, job] of list.entries()) {
    const own = job.state === 'waiting' && job.priority === null ? seasonOf(job) : null;
    if (!own) continue;
    slots.set(own.titleKey, [...(slots.get(own.titleKey) ?? []), index]);
  }
  for (const group of slots.values()) {
    if (group.length < 2) continue;
    const ordered = group.map((index) => list[index]!).sort((a, b) => seasonOf(a)!.season - seasonOf(b)!.season);
    group.forEach((slot, position) => {
      list[slot] = ordered[position]!;
    });
  }
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

export const jobEta = (finder: Finder, job: Job) => Math.max(job.runAt, Date.now(), indexerWaitOf(finder, job));

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
};
const currentText = (text: string) => RENAMED_REASONS[text] ?? text;

// The reasons of a release that the search rejected.
function rejectedReasons(release: { reasons?: string[] }) {
  return (release.reasons ?? []).map(currentText);
}

export function view(poller: Poller, importStatus: ImportStatus | undefined, entry: QueueEntry, lane: Map<string, number>, detail = false) {
  const title = titleOf(entry)!;
  const description = describe(entry.state);
  const episode = entry.season === null ? undefined : title.episodes.find((e) => e.season === entry.season && e.number === entry.number);
  const transfer = entry.transferHash ? poller.transfer(entry.transferHash) : undefined;
  const parsed = entry.release ? parseRelease(entry.release.title) : null;
  // A release name that gives neither a source nor a resolution has no quality to show.
  const quality = parsed && (parsed.source !== 'unknown' || parsed.resolution !== null) ? qualityLabel(parsed.source, parsed.resolution) : null;
  const info = reasonOf(entry);
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
    stateSince: entry.stateSince,
    revision: entry.revision,
    lane: lane.get(entry.id) ?? null,
    attempt: entry.attempt,
    completedAt: entry.completedAt,
    clearedAt: entry.clearedAt,
    release: entry.release ? { title: entry.release.title, indexer: entry.release.indexerName, sizeBytes: entry.release.sizeBytes, kind: entry.release.kind, manual: entry.release.manual, comment: entry.release.comment ?? null, quality } : null,
    file: fileOf(entry, title, transfer),
    // The client has a torrent for this target. An attached torrent is one that the user chose. ladarr did not add it.
    hasTorrent: Boolean(entry.transferHash),
    attached: Boolean(entry.release?.external),
    // The link and the magnet stay on the server: they carry the API key of the indexer.
    search: entry.search
      ? {
          ...entry.search,
          rejected: (entry.search.rejected ?? []).map((release) => ({
            indexerId: release.indexerId,
            guid: release.guid,
            title: release.title,
            sizeBytes: release.sizeBytes,
            seeders: release.seeders,
            resolution: release.resolution,
            source: release.source,
            kind: release.kind,
            reasons: rejectedReasons(release),
            sizeRejection: release.sizeRejection,
          })),
        }
      : null,
    // A pack gives one transfer to several entries. The numbers are the numbers of the torrent, and they count once.
    // The part of an episode comes from its own file when the client reports it.
    transfer: transfer
      ? {
          hash: transfer.hash,
          progress: transfer.entryProgress?.[entry.id] ?? transfer.progress,
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

export const bySeasonNumber = (a: QueueEntry, b: QueueEntry) => {
  const left = queueEpisode(a);
  const right = queueEpisode(b);
  return (left?.season ?? 0) - (right?.season ?? 0) || (left?.number ?? 0) - (right?.number ?? 0);
};

// The rows of the queue, before the page and after the filters. The counters read the same rows, so a badge and the
// rows of its tab always agree.
function groupsOf(f: Filters, poller?: Poller): RowGroup[] {
  const groups = new Map<string, RowGroup>();
  for (const entry of Object.values(db.data.queue)) {
    if (!shown(entry) || (!f.cleared && entry.clearedAt)) continue;
    const title = titleOf(entry)!;
    const season = queueEpisode(entry)?.season ?? null;
    const key = season === null ? entry.id : `${entry.titleKey}:${season}`;
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
    if (matches(entry, f)) group.matching++;
    group.first = Math.min(group.first, entry.createdAt);
    // An available target is finished. It does not hold the group back.
    if (entry.state.kind !== 'available') group.progress = Math.min(group.progress, progressOf(entry));
    // A download that works: the client has a part of its file.
    if (entry.state.kind === 'downloading' && poller) {
      const transfer = entry.transferHash ? poller.transfer(entry.transferHash) : undefined;
      // The part of the least advanced file, for the order of the rows. A pack downloads its files one by one.
      const part = transfer ? (transfer.entryProgress?.[entry.id] ?? transfer.progress) : null;
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
    .filter((group) => group.matching > 0 && Number.isFinite(group.progress) && (!f.key || group.pending || groupAggregate(group.entries).tabs.some((tab) => tab === f.key)))
    .sort(
      (a, b) =>
        Number(a.notFound) - Number(b.notFound) ||
        Number(a.upcoming) - Number(b.upcoming) ||
        b.progress - a.progress ||
        b.part - a.part ||
        Number(b.ready) - Number(a.ready) ||
        Number(b.searching) - Number(a.searching) ||
        a.first - b.first ||
        a.key.localeCompare(b.key),
    );
}

// The targets of a season that the manual search of the other seasons of the releases can take. A pack that held a part
// of the season stops them, and the search of the other seasons is the way out.
export const otherSeasonsTargets = (titleKey: string, season: number | null) =>
  Object.values(db.data.queue).filter(
    (entry) => entry.titleKey === titleKey && (season === null || entry.season === season) && shown(entry) && needsOtherSeasons(entry.state),
  );

// The aggregate of a group. It covers every member of the season, before the tab filter and the page.
export function groupAggregate(entries: QueueEntry[]) {
  const result = aggregate(entries.map((entry) => entry.state));
  return {
    status: result.status,
    counts: result.counts,
    tabs: result.tabs,
    total: result.total,
    problem: reasonOfProblem(result.problem),
    actions: actionsOf(entries),
    otherSeasons: entries.filter((entry) => needsOtherSeasons(entry.state)).length,
  };
}

function groupRow(group: RowGroup): QueueGroupRow {
  const summary = groupAggregate(group.entries);
  return {
    kind: 'group',
    key: group.key,
    titleKey: group.entries[0]!.titleKey,
    title: group.title.meta.title,
    year: group.title.meta.year,
    posterPath: group.title.meta.posterPath,
    season: group.season,
    ...(group.title.numbering?.ranges.some((range) => range.season !== range.releaseSeason && (range.season === group.season || range.releaseSeason === group.season))
      ? { numberingRevision: group.title.numbering.revision } : {}),
    status: summary.status,
    total: summary.total,
    reached: reachedOf(group.entries),
    download: group.download < 0 ? null : group.download,
    matching: group.matching,
    counts: summary.counts,
    tabs: summary.tabs,
    problem: summary.problem,
    actions: summary.actions,
    otherSeasons: summary.otherSeasons,
    priority: group.entries.some((entry) => entry.priority !== null && isActive(entry)),
  };
}

function groupRowOf(group: RowGroup, poller: Poller, importStatus: ImportStatus | undefined, lane: Map<string, number>): QueueRow {
  if (group.pending) {
    return { kind: 'pending', key: group.key, titleKey: group.key, title: group.title.meta.title, year: group.title.meta.year, posterPath: group.title.meta.posterPath, season: null, priority: false };
  }
  const first = group.entries[0]!;
  if (first.season === null) return { kind: 'entry', ...view(poller, importStatus, first, lane) };
  return groupRow(group);
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
    const tabs = group.pending ? ['searching' as Tab] : groupAggregate(group.entries).tabs;
    for (const tab of tabs) counts[tab] = (counts[tab] ?? 0) + 1;
  }
  return counts;
}

export { aggregate, describe, phaseOf };
