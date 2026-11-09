import { qualityLabel } from '../library/grab/quality.ts';
import { parseRelease } from '../library/grab/release.ts';
import type { Finder } from '../library/grab/finder.ts';
import type { Db } from '../core/db.ts';
import type { Job } from '../core/jobs.ts';
import { reasonInfo } from '../core/reasons.ts';
import type { ImportStatus } from '../library/imports/status.ts';
import type { Title } from '../library/library.ts';
import type { Poller, Transfer } from '../library/downloads/poller.ts';
import { isActive, queueKey, STAGES, type QueueEntry } from '../library/downloads/queue.ts';

export const DAY_MS = 24 * 60 * 60_000;
export const MAX_PAGE = 200;
// The key of an entry for a filter. A target whose last search found no release, or no release that fits the preset,
// waits for its next search in Waiting, with its result. A target that searches or fetches its release shows in
// Searching, because fetching belongs to the search.
export const searchKey = (key: string) =>
  key === 'not_found' || key === 'no_match' ? 'queued' : key === 'waiting' || key === 'fetching' ? 'searching' : key;
// Validating belongs to the import, so it shows in the same tab.
export const importKey = (key: string) => (key === 'validating' ? 'importing' : key);
export const filterKeyOf = (entry: QueueEntry) => importKey(searchKey(queueKey(entry)));

// The jobs that move a target through the download flow. The jobs page shows only these.
const ITEM_JOB_TYPES = new Set(['queue.initial', 'queue.search', 'queue.grab', 'import.run']);
export const isItemJob = (job: Job) => job.type.startsWith('item.') || ITEM_JOB_TYPES.has(job.type);

// The place of a stage in the journey, from the least to the most advanced. A target that searches or fetches its
// release is at the searching place.
export const STAGE_RANK = new Map(STAGES.map((stage, index) => [stage, index]));
export const progressOf = (entry: QueueEntry) => {
  const key = queueKey(entry);
  const stage = searchKey(key) === 'searching' ? 'searching' : entry.stage;
  return STAGE_RANK.get(stage)!;
};

export const pad = (n: number) => String(n).padStart(2, '0');

// The targets of a group that finished each stage, for the line under its status.
export function reachedOf(entries: QueueEntry[]) {
  const reached = { found: 0, completed: 0, validated: 0, imported: 0 };
  for (const entry of entries) {
    if (entry.release) reached.found++;
    if (entry.stage === 'validating' || entry.stage === 'importing' || entry.stage === 'available') reached.completed++;
    if (entry.stage === 'importing' || entry.stage === 'available') reached.validated++;
    if (entry.stage === 'available') reached.imported++;
  }
  return reached;
}

// A search that waits for its next run is future work only while one of its targets still waits. A target that
// finished, stopped, or paused leaves no future search behind.
export const showsSearch = (db: Db, job: Job) => {
  if (job.type !== 'queue.search' || job.state !== 'waiting' || job.runAt <= Date.now()) return true;
  const payload = job.payload as { entryIds?: string[] } | null;
  return Boolean(
    payload?.entryIds?.some((id) => {
      const entry = db.data.queue[id];
      const title = entry ? db.data.titles[entry.titleKey] : undefined;
      return entry?.branch === 'waiting' && Boolean(title && !title.paused);
    }),
  );
};

export const titleOf = (db: Db, entry: QueueEntry): Title | undefined => db.data.titles[entry.titleKey];
export const shown = (db: Db, entry: QueueEntry) => entry.attempt > 0 && Boolean(titleOf(db, entry));
export const titleName = (title: Title) => `${title.meta.title}${title.meta.year ? ` (${title.meta.year})` : ''}`;

export function label(db: Db, entry: QueueEntry) {
  const title = titleOf(db, entry)!;
  if (entry.season === null) return titleName(title);
  return `${title.meta.title} S${pad(entry.season)}E${pad(entry.number!)}`;
}

// The target of a job. A job without a target has no entry.
export function jobEntry(db: Db, job: Job): QueueEntry | undefined {
  const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
  const targets = payload?.entryIds?.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry)) ?? [];
  // A future search names a target that still waits, not one that its payload kept after the target moved on.
  const first = job.type === 'queue.search' && job.state === 'waiting' ? (targets.find((entry) => entry.branch === 'waiting') ?? targets[0]) : targets[0];
  if (first) return first;
  if (payload?.hash) return Object.values(db.data.queue).find((entry) => entry.transferHash === payload.hash);
  return undefined;
}

// The title of a job. A job without a target can still name the title of its key.
export function jobTitle(db: Db, job: Job): Title | undefined {
  const entry = jobEntry(db, job);
  if (entry && titleOf(db, entry)) return titleOf(db, entry);
  const payload = job.payload as { key?: string; titleKey?: string } | null;
  const key = payload?.key ?? payload?.titleKey;
  return key ? db.data.titles[key] : undefined;
}

// The target of a job, as the queue names it. A job without a target has no label.
export function jobLabel(db: Db, job: Job): string | null {
  const payload = job.payload as { titleKey?: string; season?: number | null; entryIds?: string[] } | null;
  // A search covers a whole season. Its label names the season, so the row does not look like one episode.
  if (job.type === 'queue.search' && typeof payload?.season === 'number' && (payload.entryIds?.length ?? 0) > 1) {
    const title = payload.titleKey ? db.data.titles[payload.titleKey] : undefined;
    if (title) return `${titleName(title)} S${pad(payload.season)}`;
  }
  const entry = jobEntry(db, job);
  if (entry && titleOf(db, entry)) return label(db, entry);
  const title = jobTitle(db, job);
  return title ? titleName(title) : null;
}

// The jobs of the item flow that run now or wait for the worker, in the order that the page shows them. A running
// job comes first, because it is the current work of the Activity page. Then the waiting jobs follow in the order
// that the worker starts them.
export function itemJobs(db: Db) {
  return Object.values(db.data.jobs)
    .filter((job) => (job.state === 'waiting' || job.state === 'running') && isItemJob(job) && showsSearch(db, job))
    .sort((a, b) => {
      if (a.state !== b.state) return a.state === 'running' ? -1 : 1;
      if (a.priority !== null || b.priority !== null) {
        if (a.priority === null) return 1;
        if (b.priority === null) return -1;
        return a.priority - b.priority;
      }
      return a.runAt - b.runAt || a.seq - b.seq;
    });
}

// The next request that the indexers of a job can take. A job that does not touch an indexer has no wait.
export function indexerWaitOf(db: Db, finder: Finder, job: Job): number {
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

export const jobEta = (db: Db, finder: Finder, job: Job) => Math.max(job.runAt, Date.now(), indexerWaitOf(db, finder, job));

export function lanePositions(db: Db) {
  const lane = Object.values(db.data.queue).filter((entry) => entry.priority !== null && isActive(entry) && entry.attempt > 0);
  lane.sort((a, b) => a.priority! - b.priority!);
  return new Map(lane.map((entry, index) => [entry.id, index + 1]));
}

// The step of the import journal for an entry. The hard link or copy and the step are separate from the bytes of a copy.
export function importOf(db: Db, importStatus: ImportStatus | undefined, entry: QueueEntry) {
  if (entry.stage !== 'importing') return null;
  for (const journal of Object.values(db.data.imports)) {
    const step = journal.steps.find((item) => item.entryIds.includes(entry.id));
    if (!step) continue;
    const copy = importStatus?.copyOfStep(journal.id, step.dest);
    return { state: step.state, method: step.method, copy: copy ? { copiedBytes: copy.copiedBytes, totalBytes: copy.totalBytes, observedAt: copy.observedAt } : null };
  }
  return null;
}

// The file of a target: the file of its open import, its file in the client, or its record in the library.
export function fileOf(db: Db, entry: QueueEntry, title: Title, transfer?: Transfer) {
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

export function view(db: Db, poller: Poller, importStatus: ImportStatus | undefined, entry: QueueEntry, lane: Map<string, number>, detail = false) {
  const title = titleOf(db, entry)!;
  const episode = entry.season === null ? undefined : title.episodes.find((e) => e.season === entry.season && e.number === entry.number);
  const transfer = entry.transferHash ? poller.transfer(entry.transferHash) : undefined;
  const parsed = entry.release ? parseRelease(entry.release.title) : null;
  // A release name that gives neither a source nor a resolution has no quality to show.
  const quality = parsed && (parsed.source !== 'unknown' || parsed.resolution !== null) ? qualityLabel(parsed.source, parsed.resolution) : null;
  const info = entry.reason ? reasonInfo(entry.reason.code) : null;
  const base = {
    id: entry.id,
    titleKey: entry.titleKey,
    mediaType: title.mediaType,
    title: title.meta.title,
    year: title.meta.year,
    posterPath: title.meta.posterPath,
    season: entry.season,
    number: entry.number,
    episodeName: episode?.name ?? null,
    label: label(db, entry),
    stage: entry.stage,
    branch: entry.branch,
    key: queueKey(entry),
    reason: entry.reason && info ? { code: entry.reason.code, message: info.message, action: info.action, settings: info.settings ?? null } : null,
    stageSince: entry.stageSince,
    revision: entry.revision,
    lane: lane.get(entry.id) ?? null,
    attempt: entry.attempt,
    completedAt: entry.completedAt,
    clearedAt: entry.clearedAt,
    release: entry.release ? { title: entry.release.title, indexer: entry.release.indexerName, sizeBytes: entry.release.sizeBytes, kind: entry.release.kind, manual: entry.release.manual, quality } : null,
    file: fileOf(db, entry, title, transfer),
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
            grabbable: release.grabbable,
            reasons: release.reasons,
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
    import: importOf(db, importStatus, entry),
  };
  if (!detail) return base;
  return {
    ...base,
    history: entry.history,
    attempts: entry.attempts,
    manualMatch: entry.manualMatch,
  };
}

export type Filters = { key?: string; type?: string; q?: string; priority: boolean; cleared: boolean };
export const filtersOf = (query: Record<string, unknown>): Filters => ({
  key: typeof query.stage === 'string' ? query.stage : undefined,
  type: typeof query.type === 'string' ? query.type : undefined,
  q: typeof query.q === 'string' && query.q.trim() ? query.q.trim().toLowerCase() : undefined,
  priority: query.priority === '1',
  cleared: query.cleared === '1',
});

export function matches(db: Db, entry: QueueEntry, f: Filters) {
  if (!shown(db, entry)) return false;
  if (!f.cleared && entry.clearedAt) return false;
  if (f.key && filterKeyOf(entry) !== f.key) return false;
  const title = titleOf(db, entry)!;
  if (f.type && title.mediaType !== f.type) return false;
  if (f.q && !title.meta.title.toLowerCase().includes(f.q)) return false;
  if (f.priority && (entry.priority === null || !isActive(entry))) return false;
  return true;
}

export const bySeasonNumber = (a: QueueEntry, b: QueueEntry) => (a.season ?? 0) - (b.season ?? 0) || (a.number ?? 0) - (b.number ?? 0);
