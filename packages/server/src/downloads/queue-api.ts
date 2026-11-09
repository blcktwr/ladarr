import type { QueueJob, QueueMatchPreview, QueuePackFiles, QueuePage, QueueRow } from '@ladarr/shared/types';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import { REJECTION_TEXT } from '../acquisition/decide.ts';
import type { Finder } from '../acquisition/finder.ts';
import { qualityLabel } from '../acquisition/quality.ts';
import { parseRelease } from '../acquisition/release.ts';
import type { ImportStatus } from '../library/import-status.ts';
import { listDownloadFiles } from '../library/importer.ts';
import { deprioritize, enqueue as enqueueJob, prioritize, type EnqueueInput, type Job } from '../core/jobs.ts';
import type { Title } from '../library/library.ts';
import type { Poller, Transfer } from './poller.ts';
import { attachRouter } from './queue-attach.ts';
import type { Clients } from './client-api.ts';
import { ClientError, type ClientHandle, type Torrent } from './qbittorrent.ts';
import { addedByApp, isActive, loadingTitleKeys, queueKey, STAGES, type Covered, type Queue, type QueueEntry } from './queue.ts';
import { reasonInfo } from '../core/reasons.ts';

type Deps = {
  db: Db;
  queue: Queue;
  finder: Finder;
  poller: Poller;
  clients: Clients;
  enqueue: (input: EnqueueInput) => Job;
  persist?: () => void;
  importStatus?: ImportStatus;
};

const DAY_MS = 24 * 60 * 60_000;
const MAX_PAGE = 200;
// The key of an entry for a filter. A target that waits for its turn in the queue is Waiting. A target that waits
// for its next search is Searching, also when the last search found no release.
const filterKeyOf = (entry: QueueEntry) => {
  const key = queueKey(entry);
  return key === 'waiting' || key === 'not_found' ? 'searching' : key;
};

// The jobs that move a target through the download flow. The jobs page shows only these.
const ITEM_JOB_TYPES = new Set(['queue.initial', 'queue.search', 'queue.grab', 'import.run']);
const isItemJob = (job: Job) => job.type.startsWith('item.') || ITEM_JOB_TYPES.has(job.type);

// The place of a stage in the journey, from the least to the most advanced. A target that waits for its next
// search is at the searching place.
const STAGE_RANK = new Map(STAGES.map((stage, index) => [stage, index]));
const progressOf = (entry: QueueEntry) => {
  const key = queueKey(entry);
  return STAGE_RANK.get(key === 'waiting' || key === 'not_found' || key === 'no_match' ? 'searching' : entry.stage)!;
};

const pad = (n: number) => String(n).padStart(2, '0');

// The active targets that point at the same torrent.
const sharingOf = (db: Db, entry: QueueEntry) => (entry.transferHash ? Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && isActive(other)) : [entry]);

// A new search, or a new send, for a target that waits for the user.
export function createRetry({ db, queue, finder, enqueue }: Pick<Deps, 'db' | 'queue' | 'finder' | 'enqueue'>) {
  const sharing = (entry: QueueEntry) => sharingOf(db, entry);

  function reset(entry: QueueEntry, cause: string) {
    queue.endAttempt(entry, 'failed', cause);
    queue.startAttempt(entry, cause);
  }

  function retry(entry: QueueEntry) {
    reset(entry, 'retry');
    const hash = entry.transferHash;
    if (hash && (entry.stage === 'validating' || entry.stage === 'importing')) {
      queue.move(entry, { branch: null, reason: null }, 'retry');
      enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
    } else if ((entry.stage === 'fetching' || entry.stage === 'sending') && entry.release) {
      queue.move(entry, { branch: null, reason: null }, 'retry');
      enqueue({ type: 'queue.grab', payload: { entryIds: sharing(entry).filter((e) => e.stage === 'fetching' || e.stage === 'sending').map((e) => e.id) }, dedupeKey: `grab:${entry.id}` });
    } else {
      entry.release = null;
      entry.transferHash = null;
      entry.clientId = null;
      entry.search = null;
      queue.move(entry, { stage: 'queued', branch: null, reason: null }, 'retry');
      finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id], fresh: true, ...(entry.season === null ? {} : { manual: true }) });
    }
  }

  // The targets that wait because of one cause, such as no indexer, go on when the user lifts that cause.
  function retryBlocked(code: string) {
    for (const entry of Object.values(db.data.queue)) if (entry.branch !== 'cancelled' && entry.branch !== 'paused' && entry.reason?.code === code && db.data.titles[entry.titleKey]) retry(entry);
  }

  return { retry, retryBlocked };
}

// The targets of a group that finished each stage, for the line under its status.
function reachedOf(entries: QueueEntry[]) {
  const reached = { found: 0, completed: 0, validated: 0, imported: 0 };
  for (const entry of entries) {
    if (entry.release) reached.found++;
    if (entry.stage === 'validating' || entry.stage === 'importing' || entry.stage === 'available') reached.completed++;
    if (entry.stage === 'importing' || entry.stage === 'available') reached.validated++;
    if (entry.stage === 'available') reached.imported++;
  }
  return reached;
}

export function queueRouter({ db, queue, finder, poller, clients, enqueue, persist = () => {}, importStatus }: Deps) {
  const router = Router();

  // A search that waits for its next run is future work only while one of its targets still waits. A target that
  // finished, stopped, or paused leaves no future search behind.
  const showsSearch = (job: Job) => {
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

  const titleOf = (entry: QueueEntry): Title | undefined => db.data.titles[entry.titleKey];
  const shown = (entry: QueueEntry) => entry.attempt > 0 && Boolean(titleOf(entry));
  const titleName = (title: Title) => `${title.meta.title}${title.meta.year ? ` (${title.meta.year})` : ''}`;

  function label(entry: QueueEntry) {
    const title = titleOf(entry)!;
    if (entry.season === null) return titleName(title);
    return `${title.meta.title} S${pad(entry.season)}E${pad(entry.number!)}`;
  }

  // The target of a job. A job without a target has no entry.
  function jobEntry(job: Job): QueueEntry | undefined {
    const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
    const targets = payload?.entryIds?.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry)) ?? [];
    // A future search names a target that still waits, not one that its payload kept after the target moved on.
    const first = job.type === 'queue.search' && job.state === 'waiting' ? (targets.find((entry) => entry.branch === 'waiting') ?? targets[0]) : targets[0];
    if (first) return first;
    if (payload?.hash) return Object.values(db.data.queue).find((entry) => entry.transferHash === payload.hash);
    return undefined;
  }

  // The title of a job. A job without a target can still name the title of its key.
  function jobTitle(job: Job): Title | undefined {
    const entry = jobEntry(job);
    if (entry && titleOf(entry)) return titleOf(entry);
    const payload = job.payload as { key?: string; titleKey?: string } | null;
    const key = payload?.key ?? payload?.titleKey;
    return key ? db.data.titles[key] : undefined;
  }

  // The target of a job, as the queue names it. A job without a target has no label.
  function jobLabel(job: Job): string | null {
    const payload = job.payload as { titleKey?: string; season?: number | null; entryIds?: string[] } | null;
    // A search covers a whole season. Its label names the season, so the row does not look like one episode.
    if (job.type === 'queue.search' && typeof payload?.season === 'number' && (payload.entryIds?.length ?? 0) > 1) {
      const title = payload.titleKey ? db.data.titles[payload.titleKey] : undefined;
      if (title) return `${titleName(title)} S${pad(payload.season)}`;
    }
    const entry = jobEntry(job);
    if (entry && titleOf(entry)) return label(entry);
    const title = jobTitle(job);
    return title ? titleName(title) : null;
  }

  // The jobs of the item flow that run now or wait for the worker, in the order that the page shows them. A running
  // job comes first, because it is the current work of the Activity page. Then the waiting jobs follow in the order
  // that the worker starts them.
  function itemJobs() {
    return Object.values(db.data.jobs)
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
  }

  // The next request that the indexers of a job can take. A job that does not touch an indexer has no wait.
  function indexerWaitOf(job: Job): number {
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

  const jobEta = (job: Job) => Math.max(job.runAt, Date.now(), indexerWaitOf(job));

  function lanePositions() {
    const lane = Object.values(db.data.queue).filter((entry) => entry.priority !== null && isActive(entry) && entry.attempt > 0);
    lane.sort((a, b) => a.priority! - b.priority!);
    return new Map(lane.map((entry, index) => [entry.id, index + 1]));
  }

  // The step of the import journal for an entry. The hard link or copy and the step are separate from the bytes of a copy.
  function importOf(entry: QueueEntry) {
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
  function fileOf(entry: QueueEntry, title: Title, transfer?: Transfer) {
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

  function view(entry: QueueEntry, lane: Map<string, number>, detail = false) {
    const title = titleOf(entry)!;
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
      label: label(entry),
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
      file: fileOf(entry, title, transfer),
      // The client has a torrent for this target. An attached torrent is one that the user chose. ladarr did not add it.
      hasTorrent: Boolean(entry.transferHash),
      attached: Boolean(entry.release?.external),
      search: entry.search ?? null,
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
      import: importOf(entry),
    };
    if (!detail) return base;
    return {
      ...base,
      history: entry.history,
      attempts: entry.attempts,
      manualMatch: entry.manualMatch,
    };
  }

  type Filters = { key?: string; type?: string; q?: string; priority: boolean; cleared: boolean };
  const filtersOf = (query: Record<string, unknown>): Filters => ({
    key: typeof query.stage === 'string' ? query.stage : undefined,
    type: typeof query.type === 'string' ? query.type : undefined,
    q: typeof query.q === 'string' && query.q.trim() ? query.q.trim().toLowerCase() : undefined,
    priority: query.priority === '1',
    cleared: query.cleared === '1',
  });

  function matches(entry: QueueEntry, f: Filters) {
    if (!shown(entry)) return false;
    if (!f.cleared && entry.clearedAt) return false;
    if (f.key && filterKeyOf(entry) !== f.key) return false;
    const title = titleOf(entry)!;
    if (f.type && title.mediaType !== f.type) return false;
    if (f.q && !title.meta.title.toLowerCase().includes(f.q)) return false;
    if (f.priority && (entry.priority === null || !isActive(entry))) return false;
    return true;
  }

  const bySeasonNumber = (a: QueueEntry, b: QueueEntry) => (a.season ?? 0) - (b.season ?? 0) || (a.number ?? 0) - (b.number ?? 0);

  router.get('/summary', (_req, res) => {
    const counts: Record<string, number> = {};
    const working: Record<string, number> = {};
    let stopped = 0;
    let targets = 0;
    for (const entry of Object.values(db.data.queue)) {
      if (!shown(entry) || entry.clearedAt) continue;
      targets++;
      const key = queueKey(entry);
      counts[key] = (counts[key] ?? 0) + 1;
      // A target that can still move has no branch and no reason. One with a reason waits for the person.
      if (entry.branch !== null || entry.stage === 'available') continue;
      if (entry.reason) stopped++;
      else working[entry.stage] = (working[entry.stage] ?? 0) + 1;
    }
    // A series that waits for its episodes counts as one target that searches.
    for (const key of loadingTitleKeys(db)) {
      targets++;
      counts.searching = (counts.searching ?? 0) + 1;
      working.searching = (working.searching ?? 0) + 1;
    }
    const transfers = poller.transfers().filter((t) => !t.complete);
    const since = Date.now() - DAY_MS;
    const current = itemJobs().find((job) => job.state === 'running');
    res.json({
      cursor: db.data.queueRev,
      counts,
      working,
      stopped,
      paused: db.data.queuePaused,
      targets,
      activeTransfers: transfers.length,
      // Each torrent counts once, also when it covers many targets.
      downloadRate: transfers.reduce((sum, t) => sum + t.downloadRate, 0),
      recentCompletions: Object.values(db.data.queue).filter((entry) => entry.completedAt && entry.completedAt > since).length,
      client: poller.status(),
      hasClient: db.data.downloadClients.some((client) => client.enabled),
      indexers: Object.keys(db.data.indexers).length,
      currentJob: current ? { type: current.type, label: jobLabel(current) } : null,
    });
  });

  // The user pauses the queue, or starts it again. Running work ends, and no new work starts.
  router.post('/pause', (req, res) => {
    const paused = (req.body ?? {}).paused;
    if (typeof paused !== 'boolean') return void res.status(400).json({ error: 'invalid_request' });
    queue.setPaused(paused);
    res.json({ paused });
  });

  router.get('/jobs', (_req, res) => {
    const jobs = itemJobs();
    res.json({
      items: jobs.map((job) => ({ id: job.id, type: job.type, state: job.state === 'running' ? 'running' : 'waiting', payload: job.payload, runAt: job.runAt, eta: jobEta(job), attempts: job.attempts, priority: job.priority, lastError: job.lastError, label: jobLabel(job), posterPath: jobTitle(job)?.meta.posterPath ?? null })),
    } satisfies { items: QueueJob[] });
  });

  // A job of the item flow starts first, before every job of the normal lane. The other jobs are not on this page.
  router.post('/jobs/:id/priority', (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    prioritize(db, job.id);
    persist();
    res.json({ done: true });
  });

  // A job of the item flow starts now, instead of waiting for its time. A paused queue still holds it.
  router.post('/jobs/:id/run', (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    job.runAt = Date.now();
    persist();
    res.json({ done: true });
  });

  // The targets of a job, so a job that the user removes does not leave a target that waits for work that is gone.
  function targetsOf(job: Job): QueueEntry[] {
    const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
    if (payload?.entryIds?.length) return payload.entryIds.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry));
    if (payload?.hash) return Object.values(db.data.queue).filter((entry) => entry.transferHash === payload.hash);
    return [];
  }

  // The user takes a job of the item flow out of the queue. Its targets stop with a reason, so the sweep does not
  // put the same job back. A running job keeps its lease.
  router.delete('/jobs/:id', (req, res) => {
    const job = db.data.jobs[req.params.id];
    if (!job || !isItemJob(job)) return void res.status(404).json({ error: 'not_found' });
    if (job.state !== 'waiting') return void res.status(409).json({ error: 'job_not_waiting' });
    const targets = targetsOf(job);
    delete db.data.jobs[job.id];
    for (const entry of targets) {
      if (!isActive(entry) || entry.branch === 'paused' || entry.branch === 'cancelled') continue;
      if (entry.branch === 'waiting' && entry.search) entry.search.nextAt = null;
      queue.move(entry, { branch: null, reason: { code: 'job_removed' } }, 'job removed by the user');
    }
    persist();
    res.json({ done: true });
  });

  // One page of rows: a group for each series, and one row for each movie. Rows with the most advanced progress come
  // first, and ties keep the order of creation. A row leaves the list when its targets are all available.
  router.get('/', (req, res) => {
    const f = filtersOf(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_PAGE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const lane = lanePositions();
    const all = Object.values(db.data.queue);
    const cursor = db.data.queueRev;

    if (f.priority) {
      const rows = all.filter((entry) => matches(entry, f)).sort((a, b) => a.priority! - b.priority!);
      return void res.json({ cursor, total: rows.length, items: rows.slice(offset, offset + limit).map((entry) => ({ kind: 'entry', ...view(entry, lane) })) });
    }

    // Counts of a group cover all its entries in the view. A filter picks the groups that have a matching entry.
    // The progress of a group is that of its least advanced target, so the number of episodes does not matter.
    const groups = new Map<string, { entries: QueueEntry[]; matching: number; first: number; progress: number }>();
    for (const entry of all) {
      if (!shown(entry) || (!f.cleared && entry.clearedAt)) continue;
      const key = entry.season === null ? entry.id : entry.titleKey;
      const group = groups.get(key) ?? { entries: [], matching: 0, first: entry.createdAt, progress: Number.POSITIVE_INFINITY };
      group.entries.push(entry);
      if (matches(entry, f)) group.matching++;
      group.first = Math.min(group.first, entry.createdAt);
      // An available target is finished. It does not hold the group back.
      if (entry.stage !== 'available') group.progress = Math.min(group.progress, progressOf(entry));
      groups.set(key, group);
    }
    // A series that waits for its episodes has no target yet. The page shows the series itself as searching, so
    // the row is in the queue from the moment of the add.
    for (const key of loadingTitleKeys(db)) {
      const title = db.data.titles[key];
      if (!title) continue;
      const matchesLoading = !f.cleared && !f.priority && (!f.key || f.key === 'searching') && (!f.type || f.type === 'tv') && (!f.q || title.meta.title.toLowerCase().includes(f.q));
      if (!matchesLoading) continue;
      groups.set(key, { entries: [], matching: 1, first: title.addedAt, progress: STAGE_RANK.get('searching')! });
    }
    const rows = [...groups.entries()].filter(([, g]) => g.matching > 0 && Number.isFinite(g.progress)).sort((a, b) => b[1].progress - a[1].progress || a[1].first - b[1].first || a[0].localeCompare(b[0]));
    const items: QueueRow[] = rows.slice(offset, offset + limit).map(([key, group]) => {
      const first = group.entries[0];
      if (!first) {
        const title = db.data.titles[key]!;
        return {
          kind: 'group',
          key,
          titleKey: key,
          title: title.meta.title,
          year: title.meta.year,
          posterPath: title.meta.posterPath,
          season: null,
          total: 0,
          reached: { found: 0, completed: 0, validated: 0, imported: 0 },
          matching: group.matching,
          counts: { searching: 1 },
          priority: false,
          pending: true,
        };
      }
      if (first.season === null) return { kind: 'entry', ...view(first, lane) };
      const title = titleOf(first)!;
      const counts: Record<string, number> = {};
      for (const entry of group.entries) counts[queueKey(entry)] = (counts[queueKey(entry)] ?? 0) + 1;
      return {
        kind: 'group',
        key,
        titleKey: first.titleKey,
        title: title.meta.title,
        year: title.meta.year,
        posterPath: title.meta.posterPath,
        season: null,
        total: group.entries.length,
        reached: reachedOf(group.entries),
        matching: group.matching,
        counts,
        priority: group.entries.some((entry) => entry.priority !== null && isActive(entry)),
      };
    });
    res.json({ cursor, total: rows.length, items } satisfies QueuePage);
  });

  // The episodes of one series, of every season, in the order of the season and the number.
  router.get('/groups/:titleKey', (req, res) => {
    const f = filtersOf(req.query);
    const lane = lanePositions();
    const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === req.params.titleKey && entry.season !== null && matches(entry, f));
    res.json({ cursor: db.data.queueRev, items: entries.sort(bySeasonNumber).map((entry) => view(entry, lane)) });
  });

  router.get('/recent', (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), MAX_PAGE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const lane = lanePositions();
    const done = Object.values(db.data.queue).filter((entry) => entry.stage === 'available' && entry.completedAt && shown(entry)).sort((a, b) => b.completedAt! - a.completedAt!);
    res.json({ total: done.length, items: done.slice(offset, offset + limit).map((entry) => view(entry, lane)) });
  });

  router.get('/entries/:id', (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    res.json({ entry: view(entry, lanePositions(), true) });
  });

  // --- Requests ---------------------------------------------------------------------------

  router.post('/search', (req, res) => {
    const { titleKey, season, number } = (req.body ?? {}) as { titleKey?: unknown; season?: unknown; number?: unknown };
    const isNumber = (value: unknown) => value === undefined || (Number.isInteger(value) && (value as number) >= 0);
    if (typeof titleKey !== 'string' || !db.data.titles[titleKey] || !isNumber(season) || !isNumber(number)) return void res.status(400).json({ error: 'invalid_request' });
    // A request with a number is a target that the user selected. Its individual query runs whatever the age of the episode.
    const started = finder.requestSearch(titleKey, { season: season as number | undefined, number: number as number | undefined, fresh: true, manual: number !== undefined });
    res.status(202).json({ started: started.map((entry) => entry.id) });
  });

  // The releases for a target, with the reason for each rejection.
  router.get('/releases', async (req, res) => {
    const titleKey = String(req.query.titleKey ?? '');
    const season = req.query.season === undefined ? undefined : Number(req.query.season);
    const number = req.query.number === undefined ? undefined : Number(req.query.number);
    if (!db.data.titles[titleKey] || (season !== undefined && !Number.isInteger(season)) || (number !== undefined && !Number.isInteger(number))) return void res.status(400).json({ error: 'invalid_request' });
    const result = await finder.interactive(titleKey, { season, number, fresh: req.query.fresh === '1' }, AbortSignal.timeout(10 * 60_000));
    if (!result) return void res.status(404).json({ error: 'not_found' });
    res.json({
      asked: result.asked,
      answered: result.answered,
      // A release of another title is noise: the indexer matched the words, and ladarr can never take it.
      releases: result.decisions
        .filter(({ decision }) => !decision.rejections.includes('wrong_title'))
        .map(({ decision, overridable }) => ({
          indexerId: decision.release.indexerId,
          guid: decision.release.guid,
          title: decision.release.title,
          indexer: db.data.indexers[decision.release.indexerId]?.push.sonarr?.name ?? db.data.indexers[decision.release.indexerId]?.push.radarr?.name ?? 'Indexer',
          sizeBytes: decision.release.sizeBytes,
          seeders: decision.release.seeders,
          kind: decision.kind,
          accepted: decision.accepted,
          overridable,
          rejections: decision.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })),
        }))
        .sort((a, b) => Number(b.accepted) - Number(a.accepted) || Number(b.overridable) - Number(a.overridable) || b.sizeBytes - a.sizeBytes),
    });
  });

  router.post('/releases/grab', async (req, res) => {
    const { titleKey, season, number, indexerId, guid } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof titleKey !== 'string' || typeof guid !== 'string' || typeof indexerId !== 'number' || !db.data.titles[titleKey]) return void res.status(400).json({ error: 'invalid_request' });
    const result = await finder.interactive(titleKey, { season: season as number | undefined, number: number as number | undefined }, AbortSignal.timeout(10 * 60_000));
    const found = result?.decisions.find(({ decision }) => decision.release.guid === guid && decision.release.indexerId === indexerId);
    if (!found) return void res.status(404).json({ error: 'release_not_found' });
    const { want, decision } = found;
    const title = db.data.titles[titleKey]!;
    const targets: [number | null, number | null][] =
      want.kind === 'movie' ? [[null, null]] : want.kind === 'episode' ? [[want.season, want.number]] : decision.covers.filter((c) => title.episodes.some((e) => e.season === c.season && e.number === c.number)).map((c) => [c.season, c.number]);
    const entries = targets.map(([s, n]) => queue.ensure(titleKey, s, n));
    const outcome = finder.grabManual(entries, decision.release, want);
    if (!('reserved' in outcome)) return void res.status(409).json({ error: 'release_rejected', rejections: outcome.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })) });
    res.status(202).json({ started: entries.map((entry) => entry.id) });
  });

  // --- Actions ----------------------------------------------------------------------------

  type Action = 'pause' | 'resume' | 'retry' | 'priority' | 'unpriority' | 'clear' | 'remove_torrent';
  const ACTIONS: Action[] = ['pause', 'resume', 'retry', 'priority', 'unpriority', 'clear', 'remove_torrent'];

  const jobsOf = (entry: QueueEntry) =>
    Object.values(db.data.jobs).filter((job) => {
      const payload = job.payload as { entryIds?: string[]; hash?: string } | null;
      return Boolean(payload?.entryIds?.includes(entry.id)) || Boolean(payload?.hash && payload.hash === entry.transferHash);
    });

  const sharing = (entry: QueueEntry) => sharingOf(db, entry);

  // The torrent is one that a target of ladarr sent to the client.
  // Says if the action fits the stage of the entry. A refusal is clear and changes nothing.
  function supports(action: Action, entry: QueueEntry, removal?: { torrents: Map<string, Torrent>; attached: Set<string> }): string | null {
    const early = ['queued', 'searching', 'fetching', 'sending'].includes(entry.stage);
    switch (action) {
      case 'pause':
        return entry.branch === null && (early || entry.stage === 'downloading') ? null : 'The stage of this target does not allow a pause.';
      case 'resume':
        return entry.branch === 'paused' ? null : 'This target is not paused.';
      case 'retry':
        return entry.branch !== 'paused' && entry.branch !== 'cancelled' && entry.reason !== null ? null : 'This target does not need a retry.';
      case 'priority':
        return isActive(entry) && entry.priority === null && entry.branch !== 'paused' && early ? null : 'Only waiting work can have priority.';
      case 'unpriority':
        return entry.priority !== null ? null : 'This target has no priority.';
      case 'clear':
        return (entry.stage === 'available' || entry.branch === 'cancelled') && !entry.clearedAt ? null : 'Only finished targets can be cleared.';
      case 'remove_torrent': {
        if (!entry.transferHash) return 'This target has no torrent.';
        if (sharing(entry).length > 0) return 'A target still uses this torrent.';
        // ladarr removes only a torrent that it added. A download that the user attached stays in the client.
        if (removal?.attached.has(entry.transferHash)) return 'This torrent was not added by the app. Remove it in the download client.';
        const found = removal?.torrents.get(entry.transferHash);
        return found && !addedByApp(db, found.hash) ? 'This torrent was not added by the app. Remove it in the download client.' : null;
      }
    }
  }

  // The entries that the action changes. Pause and resume of a download act on the whole transfer.
  function scope(action: Action, entry: QueueEntry) {
    // The torrent goes for all targets that point at it.
    if (action === 'remove_torrent') return Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash);
    if ((action === 'pause' || action === 'resume') && entry.stage === 'downloading' && entry.transferHash) {
      return Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && other.stage === 'downloading' && (action === 'pause' ? other.branch === null : other.branch === 'paused'));
    }
    return [entry];
  }

  const { retry } = createRetry({ db, queue, finder, enqueue });

  async function apply(action: Action, entries: QueueEntry[]) {
    const removed = new Set<string>();
    for (const entry of entries) {
      // Each target acts on the client that has its torrent.
      const api = clients.get(entry.clientId)?.api;
      switch (action) {
        case 'pause': {
          if (entry.stage === 'downloading') {
            if (!api) throw new ClientError('unreachable', 'No download client.');
            await api.setPaused(entry.transferHash!, true);
          }
          queue.move(entry, { branch: 'paused' }, 'paused by the user');
          break;
        }
        case 'resume': {
          if (entry.stage === 'downloading') {
            if (!api) throw new ClientError('unreachable', 'No download client.');
            await api.setPaused(entry.transferHash!, false);
            queue.move(entry, { branch: null }, 'resumed by the user');
          } else if ((entry.stage === 'fetching' || entry.stage === 'sending') && entry.release) {
            queue.move(entry, { branch: null }, 'resumed by the user');
            enqueue({ type: 'queue.grab', payload: { entryIds: [entry.id] }, dedupeKey: `grab:${entry.id}` });
          } else {
            queue.move(entry, { stage: 'queued', branch: null, reason: null }, 'resumed by the user');
            finder.enqueueSearch({ titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id] });
          }
          break;
        }
        case 'retry':
          retry(entry);
          break;
        case 'priority': {
          queue.setPriority(entry, true);
          for (const job of jobsOf(entry)) prioritize(db, job.id);
          break;
        }
        case 'unpriority': {
          queue.setPriority(entry, false);
          for (const job of jobsOf(entry)) deprioritize(db, job.id);
          break;
        }
        case 'clear':
          entry.clearedAt = Date.now();
          queue.touch(entry);
          break;
        case 'remove_torrent': {
          if (!api) throw new ClientError('unreachable', 'No download client.');
          // One request for each torrent, also when many targets point at it. The data stays on the disk.
          if (!removed.has(entry.transferHash!)) await api.remove(entry.transferHash!, false);
          removed.add(entry.transferHash!);
          queue.move(entry, {}, 'torrent removed from the client', 'The data stays on the disk.');
          entry.transferHash = null;
          entry.clientId = null;
          break;
        }
      }
    }
  }

  // The entries of a group in the order that they have now, for an action on a group. A null season takes every season.
  function groupEntries(titleKey: string, season: number | null) {
    return Object.values(db.data.queue).filter((entry) => entry.titleKey === titleKey && (season === null || entry.season === season) && shown(entry)).sort((a, b) => a.createdAt - b.createdAt || bySeasonNumber(a, b));
  }

  router.post('/actions', async (req, res) => {
    const { action, ids, group, preview } = (req.body ?? {}) as { action?: Action; ids?: unknown; group?: { titleKey?: string; season?: number | null }; preview?: boolean };
    if (!action || !ACTIONS.includes(action)) return void res.status(400).json({ error: 'invalid_action' });
    let picked: QueueEntry[];
    if (group && typeof group.titleKey === 'string') picked = groupEntries(group.titleKey, group.season ?? null);
    else if (Array.isArray(ids) && ids.length <= 1000 && ids.every((id) => typeof id === 'string')) picked = ids.flatMap((id) => (db.data.queue[id] && shown(db.data.queue[id]!) ? [db.data.queue[id]!] : []));
    else return void res.status(400).json({ error: 'invalid_request' });

    // Before a removal, read the torrents in the client. The queue decides if ladarr added a torrent.
    let removal: { torrents: Map<string, Torrent>; attached: Set<string> } | undefined;
    if (action === 'remove_torrent') {
      // Each client reads the hashes of the torrents that it has.
      const byClient = new Map<ClientHandle, Set<string>>();
      for (const entry of picked) {
        if (!entry.transferHash) continue;
        const handle = clients.get(entry.clientId);
        if (!handle) return void res.status(409).json({ error: 'client_missing' });
        byClient.set(handle, (byClient.get(handle) ?? new Set()).add(entry.transferHash));
      }
      try {
        const torrents = new Map<string, Torrent>();
        for (const [handle, hashes] of byClient) for (const torrent of await handle.api.byHashes([...hashes])) torrents.set(torrent.hash, torrent);
        const attached = new Set(Object.values(db.data.queue).flatMap((entry) => (entry.release?.external && entry.transferHash ? [entry.transferHash] : [])));
        removal = { torrents, attached };
      } catch (error) {
        if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
        throw error;
      }
    }

    // A group action takes the entries that the action fits. A single request for one entry that does not fit is refused.
    const unsupported: { id: string; reason: string }[] = [];
    const affected = new Map<string, QueueEntry>();
    for (const entry of picked) {
      const refusal = supports(action, entry, removal);
      if (refusal) unsupported.push({ id: entry.id, reason: refusal });
      else for (const other of scope(action, entry)) affected.set(other.id, other);
    }
    const lane = lanePositions();
    const list = [...affected.values()];
    const transfers = new Map<string, number>();
    for (const entry of list) if (entry.transferHash && ['pause', 'resume', 'remove_torrent'].includes(action)) transfers.set(entry.transferHash, (transfers.get(entry.transferHash) ?? 0) + 1);
    const summary = { action, affected: list.map((entry) => ({ id: entry.id, label: label(entry), stage: entry.stage, key: queueKey(entry), lane: lane.get(entry.id) ?? null })), unsupported, sharedTransfers: [...transfers].map(([hash, count]) => ({ name: poller.transfer(hash)?.name ?? removal?.torrents.get(hash)?.name ?? hash, entries: count })) };
    if (preview) return void res.json(summary);
    if (!list.length) return void res.status(409).json({ error: 'action_not_supported', unsupported });
    try {
      await apply(action, list);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' });
      throw error;
    }
    res.json({ ...summary, done: true });
  });

  // --- Repair -----------------------------------------------------------------------------

  router.get('/entries/:id/files', async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handle = clients.get(entry?.clientId);
    if (!entry?.transferHash || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
    try {
      const files = await listDownloadFiles(handle, entry.transferHash);
      if (!files) return void res.status(409).json({ error: 'download_not_found' });
      res.json({ files, entries: sharing(entry).map((other) => ({ id: other.id, label: label(other), season: other.season, number: other.number })) } satisfies QueuePackFiles);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  });

  // Matches a file of the download to the target, or to several episodes. The match stays through every retry.
  router.post('/entries/:id/match', async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handle = clients.get(entry?.clientId);
    const { file, covers, preview } = (req.body ?? {}) as { file?: unknown; covers?: unknown; preview?: boolean };
    if (!entry?.transferHash || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
    if (typeof file !== 'string') return void res.status(400).json({ error: 'invalid_request' });
    const files = await listDownloadFiles(handle, entry.transferHash).catch(() => undefined);
    // The file must be one that the download has. The path comes from the user, so it is never used as it is.
    if (!files?.some((item) => item.rel === file)) return void res.status(400).json({ error: 'file_not_in_download' });

    const group = sharing(entry);
    let covered: QueueEntry[] = [entry];
    if (covers !== undefined) {
      const list = covers as Covered[];
      if (!Array.isArray(list) || list.length > 50 || !list.every((c) => Number.isInteger(c?.season) && Number.isInteger(c?.number))) return void res.status(400).json({ error: 'invalid_request' });
      covered = group.filter((other) => other.titleKey === entry.titleKey && list.some((c) => c.season === other.season && c.number === other.number));
      // A cover that the download does not hold for this title is an error. It is not dropped without a word.
      if (list.some((c) => !covered.some((other) => other.season === c.season && other.number === c.number) && !(entry.season === c.season && entry.number === c.number))) return void res.status(400).json({ error: 'cover_not_in_download' });
      if (!covered.includes(entry)) covered.push(entry);
    }
    // The targets that lose the file because another target takes it.
    const taken = Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && isActive(other) && other.manualMatch?.file === file && !covered.includes(other));
    const preview_: QueueMatchPreview = {
      file,
      // The file that each target has now, so the preview shows every association that changes.
      affected: covered.map((other) => ({ id: other.id, label: label(other), current: other.manualMatch?.file ?? null })),
      replaces: taken.map((other) => ({ id: other.id, label: label(other) })),
      // A target that waits for a repair starts its import again.
      retries: covered.filter((other) => other.reason !== null && (other.stage === 'validating' || other.stage === 'importing')).map((other) => ({ id: other.id, label: label(other) })),
    };
    if (preview) return void res.json(preview_);

    for (const other of taken) other.manualMatch = null;
    const matchCovers = covered.map((other) => ({ season: other.season!, number: other.number! }));
    for (const other of covered) {
      other.manualMatch = { file, covers: other.season === null ? [] : matchCovers };
      if (other.branch !== 'paused' && other.branch !== 'cancelled' && other.reason !== null && (other.stage === 'validating' || other.stage === 'importing')) retry(other);
    }
    res.json({ ...preview_, done: true });
  });

  router.use(attachRouter({ db, queue, clients, shown, label }));

  return router;
}
