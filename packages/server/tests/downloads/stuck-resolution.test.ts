import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WorkPhase } from '@ladarr/shared/queue';
import { enqueue, JobError } from '../../src/core/jobs.ts';
import { createClients } from '../../src/library/downloads/client-api.ts';
import { createRetry } from '../../src/library/downloads/queue-api.ts';
import { ClientError } from '../../src/library/downloads/qbittorrent.ts';
import { stageOf } from '../../src/library/downloads/queue.ts';
import { unfinishedImports } from '../../src/library/imports/importer.ts';
import { requestVerification } from '../../src/library/verification.ts';
import { importRunHandler } from '../../src/jobs/import-run.ts';
import { importLocalHandler } from '../../src/jobs/import-local.ts';
import { libraryVerifyHandler } from '../../src/jobs/library-verify.ts';
import { queueGrabHandler } from '../../src/jobs/queue-grab.ts';
import { queueRetryHandler } from '../../src/jobs/queue-retry.ts';
import { queueSearchHandler } from '../../src/jobs/queue-search.ts';
import { queueSendHandler } from '../../src/jobs/queue-send.ts';
import { createFinder } from '../../src/library/grab/finder.ts';
import { REJECTION_TEXT } from '../../src/library/grab/decide.ts';
import { IndexerError } from '../../src/library/grab/torznab.ts';
import type { GrabberDeps, Queue, QueueEntry, QueueTorrent } from '../../src/types.ts';
import { episode, movie, release as rawRelease, title } from '../helpers/test-fixtures.ts';
import { hashOf, makeTorrent, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  vi.restoreAllMocks();
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const signal = () => ({ signal: new AbortController().signal });
const work = () => Object.values(pipe!.db.data.jobs).filter((job) => job.type.startsWith('queue.') || job.type === 'import.run');
const downloadName = (mediaType: 'movie' | 'tv') => mediaType === 'movie' ? 'Movie.Name.2019.1080p.BluRay-GRP' : 'Show.Name.S01.1080p.WEB-DL-GRP';
const turnOf = (entry: QueueEntry) => pipe!.queue.itemFor(entry)!;

async function setup(mediaType: 'movie' | 'tv', at: WorkPhase = 'importing', code = 'file_not_found', count = 1) {
  pipe = await startPipeline();
  pipe.poller.stop();
  pipe.db.data.queuePaused = true;
  const item = mediaType === 'movie'
    ? movie({ rootId: 'movie', manualRelease: true, metaLoadedAt: Date.now() })
    : title({ rootId: 'tv', episodes: Array.from({ length: count }, (_, index) => episode(1, index + 1)) });
  pipe.db.data.titles[item.key] = item;
  const entries = Array.from({ length: count }, (_, index) => {
    const entry = pipe!.queue.ensure(item.key, mediaType === 'movie' ? null : 1, mediaType === 'movie' ? null : index + 1);
    pipe!.queue.request(entry, 'attached download');
    if (at === 'downloading') Object.assign(entry, { transferHash: hashOf(downloadName(mediaType)), clientId: 'client-1' });
    pipe!.queue.enter(entry, at, 'download complete');
    pipe!.queue.block(entry, { code, detail: 'A human decision is necessary.' }, 'import blocked');
    entry.stateSince = Date.now() - 31 * 60_000;
    return entry;
  });
  return { item, entries, entry: entries[0]! };
}

function addDownload(entries: QueueEntry[], mediaType: 'movie' | 'tv', complete = true) {
  const name = downloadName(mediaType);
  const hash = hashOf(name);
  pipe!.qbit.torrents.set(hash, {
    hash, name, size: 1_000_000, progress: complete ? 1 : 0.5,
    state: complete ? 'uploading' : 'downloading', category: 'ladarr', tags: '',
    save_path: pipe!.folders.downloads, content_path: join(pipe!.folders.downloads, name),
    dlspeed: 0, eta: 0, num_seeds: 1, num_leechs: 0, added_on: Math.floor(Date.now() / 1000),
  });
  for (const entry of entries) {
    entry.transferHash = hash;
    entry.clientId = 'client-1';
    entry.source = { magnet: `magnet:?xt=urn:btih:${hash}` };
    entry.importTries = 1;
  }
  if (!complete && mediaType === 'tv') pipe!.qbit.setFiles(hash, entries.map((entry) => ({
    name: `${name}/Show.Name.S01E${String(entry.number).padStart(2, '0')}.mkv`, size: 1000, progress: 0.5,
  })));
  if (complete) {
    const files = mediaType === 'movie'
      ? { 'Movie.mkv': 'movie-data' }
      : Object.fromEntries(entries.map((entry) => [`Show.Name.S01E${String(entry.number).padStart(2, '0')}.mkv`, `episode-${entry.number}`]));
    pipe!.complete(name, files, hash);
  }
  return { name, hash };
}

function selectRelease(entry: QueueEntry) {
  const name = entry.season === null ? 'Movie.Name.2019.1080p.BluRay-GRP' : 'Show.Name.S01E01.1080p.WEB-DL-GRP';
  entry.release = {
    guid: name, indexerId: 1, indexerName: 'Tracker', title: name, sizeBytes: 100 * 120 * MIB,
    infoHash: null, link: `http://127.0.0.1:${pipe!.tracker.port}/1/download?file=${encodeURIComponent(name)}`,
    magnet: null, kind: 'single', seeders: 20, manual: true,
  };
  const files = [entry.season === null ? `${name}.mkv` : 'Show.Name.S01E01.mkv'];
  pipe!.tracker.state.items = [{ title: name, size: entry.release.sizeBytes, files }];
  return entry.release;
}

function grabDeps(): GrabberDeps {
  return {
    queue: pipe!.queue, finder: pipe!.finder, indexers: pipe!.indexers, clients: createClients(),
    save: async () => {}, enqueue, reconcileMs: 0,
  };
}

function prepared(entry: QueueEntry, name = entry.release!.title) {
  const path = entry.season === null ? `${name}.mkv` : 'Show.Name.S01E01.mkv';
  const files = [path];
  const hash = hashOf(name, files);
  const item = turnOf(entry);
  const source = { torrent: true } as const;
  const torrent: QueueTorrent = {
    hash, release: { ...entry.release!, guid: name, title: name, infoHash: hash }, source,
    numberingRevision: entry.season === null ? null : 0, matches: { [entry.id]: `${name}/${path}` }, clientId: null, status: 'prepared',
  };
  pipe!.db.data.torrents[hash] = makeTorrent(name, files).toString('base64');
  pipe!.queue.updateItem(item, { selected: { [hash]: torrent } });
  return torrent;
}

function beginFetch(entry: QueueEntry) {
  pipe!.queue.resolve(entry, 'fetching', 'fixture: fetch starts');
  const item = turnOf(entry);
  if (item.state.kind === 'queued') pipe!.queue.transitionItem(item, { kind: 'searching' });
  pipe!.queue.transitionItem(item, { kind: 'fetching' });
  expect(item.state).toEqual({ kind: 'fetching' });
}

function fetchJob(entry: QueueEntry) {
  const ref = entry.release!;
  return pipe!.finder.enqueueSearch({
    titleKey: entry.titleKey, season: entry.season, entryIds: [entry.id], manual: true, forced: true,
    supplied: [{ ...ref, publishedAt: null, peers: null, categories: [] }],
  });
}

function sendJob(entry: QueueEntry, torrent: QueueTorrent) {
  return enqueue({ type: 'queue.send', payload: { itemId: turnOf(entry).id, hash: torrent.hash, entryIds: [entry.id] } });
}

async function runFetchRetry(entry: QueueEntry) {
  createRetry({ queue: pipe!.queue, enqueue }).retry(entry);
  expect(turnOf(entry).state).toEqual({ kind: 'fetching' });
  const bridge = work().find((job) => job.type === 'queue.grab');
  expect(bridge).toBeDefined();
  await queueGrabHandler(grabDeps()).run(bridge!, signal());
  const search = work().find((job) => job.type === 'queue.search');
  expect(search).toBeDefined();
  await queueSearchHandler(pipe!.finder).run(search!, signal());
}

const operations: [string, (queue: Queue, entry: QueueEntry) => unknown][] = [
  ['transition', (queue, entry) => queue.transition(entry, { kind: 'importing' }, 'worker recovery')],
  ...(['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing'] as WorkPhase[])
    .map((phase): [string, (queue: Queue, entry: QueueEntry) => unknown] => [`enter ${phase}`, (queue, entry) => queue.enter(entry, phase, 'worker recovery')]),
  ['wait', (queue, entry) => queue.wait(entry, 'no_results', 'worker recovery')],
  ['complete', (queue, entry) => queue.complete(entry, 'file is in the library')],
  ['unblock', (queue, entry) => queue.unblock(entry, 'retry: the import checks run again')],
  ['fallback', (queue, entry) => queue.fallback(entry, 'verification repair')],
  ['request', (queue, entry) => queue.request(entry, 'found by RSS')],
];

describe.each(['movie', 'tv'] as const)('central stuck transitions: %s', (mediaType) => {
  it.each(operations)('makes %s a no-op without authorization', async (_name, change) => {
    const { entry } = await setup(mediaType);
    addDownload([entry], mediaType);
    const before = structuredClone(entry);
    const revision = pipe!.db.data.queueRev;

    expect(() => change(pipe!.queue, entry)).not.toThrow();

    expect(entry).toEqual(before);
    expect(pipe!.db.data.queueRev).toBe(revision);
    expect(work()).toEqual([]);
  });

  it('keeps a block that has no recorded attempt', async () => {
    const { entry } = await setup(mediaType);
    entry.attempt = 0;
    entry.attempts = [];
    const before = structuredClone(entry);

    expect(() => pipe!.queue.request(entry, 'server recovery')).not.toThrow();

    expect(entry).toEqual(before);
  });

  it('lets a diagnosis change without a continuation', async () => {
    const { entry } = await setup(mediaType);
    const attempt = entry.attempt;

    pipe!.queue.block(entry, { code: 'permission_denied', detail: 'The destination is not writable.' }, 'check result');

    expect(entry.state).toEqual({ kind: 'blocked', at: 'importing', problem: { code: 'permission_denied', detail: 'The destination is not writable.' } });
    expect(entry.attempt).toBe(attempt);
  });

  it('preserves the block through pause and resume', async () => {
    const { entry } = await setup(mediaType);
    const state = structuredClone(entry.state);

    pipe!.queue.pause(entry, 'paused by user');
    pipe!.queue.resume(entry, 'resumed by user');

    expect(entry.state).toEqual(state);
    expect(entry.completedAt).toBeNull();
  });
});

describe.each(['movie', 'tv'] as const)('automatic stuck recovery: %s', (mediaType) => {
  it.each([
    { code: 'unreachable', attempts: 1, problem: 'client_unreachable' },
    { code: 'rejected', attempts: 1, problem: 'client_rejected' },
    { code: 'unreachable', attempts: 5, problem: 'client_unreachable' },
    { code: 'rejected', attempts: 5, problem: 'client_rejected' },
  ] as const)('blocks an import client error only at the job limit: $code, attempt $attempts', async ({ code, attempts, problem }) => {
    const { entry } = await setup(mediaType);
    selectRelease(entry);
    const { hash } = addDownload([entry], mediaType);
    entry.release!.infoHash = hash;
    pipe!.queue.resolve(entry, 'importing', 'fixture: import starts');
    const acquisition = structuredClone({ release: entry.release, transferHash: entry.transferHash, clientId: entry.clientId, source: entry.source });
    const clients = createClients();
    const find = vi.spyOn(clients.get(entry.clientId)!.api, 'find').mockRejectedValue(new ClientError(code, 'The client cannot supply the download.'));
    const handler = importRunHandler({ queue: pipe!.queue, events: pipe!.events, clients, save: async () => {}, checkDelayMs: 0 });
    const job = enqueue({ type: 'import.run', payload: { hash } });
    job.attempts = attempts;

    await expect(handler.run(job, signal())).rejects.toMatchObject({ kind: 'outage' });

    expect(entry.state).toMatchObject(attempts === 5
      ? { kind: 'blocked', at: 'importing', problem: { code: problem } }
      : { kind: 'importing' });
    expect(entry).toMatchObject(acquisition);
    expect(pipe!.db.data.files).toEqual({});
    if (attempts !== 5) return;
    const before = structuredClone(entry);
    find.mockClear();

    await handler.run(enqueue({ type: 'import.run', payload: { hash } }), signal());
    const jobs = structuredClone(pipe!.db.data.jobs);
    await pipe!.poller.tick();

    expect(entry).toEqual(before);
    expect(find).not.toHaveBeenCalled();
    expect(pipe!.db.data.jobs).toEqual(jobs);
    expect(unfinishedImports()).toEqual([]);
  });

  it('does not retry a blocked import or schedule it after a restart', async () => {
    const { entry } = await setup(mediaType);
    const { hash } = addDownload([entry], mediaType);
    const before = structuredClone(entry);
    let probes = 0;
    const handler = importRunHandler({
      queue: pipe!.queue, events: pipe!.events, clients: createClients(), save: async () => {},
      probe: async () => { probes++; return { ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] }; },
      checkDelayMs: 0,
    });

    await handler.run(enqueue({ type: 'import.run', payload: { hash } }), signal());

    expect(entry).toEqual(before);
    expect(probes).toBe(0);
    expect(pipe!.db.data.files).toEqual({});
    expect(unfinishedImports()).toEqual([]);
  });

  it.each(['file_not_found', 'torrent_missing'])('does not repair an old %s block before import', async (code) => {
    const { entry } = await setup(mediaType, 'downloading', code);
    const before = structuredClone(entry);

    pipe!.finder.repairBlocked(entry.titleKey);
    pipe!.finder.sweep();

    expect(entry).toEqual(before);
    expect(work()).toEqual([]);
    expect(pipe!.tracker.state.searches).toEqual([]);
  });

  it('does not retry blocked targets after a configuration change', async () => {
    const { entry } = await setup(mediaType, 'searching', 'no_indexers');
    const before = structuredClone(entry);
    const { retryBlocked } = createRetry({ queue: pipe!.queue, enqueue });

    retryBlocked('no_indexers');

    expect(entry).toEqual(before);
    expect(work()).toEqual([]);
  });

  it.each(['torrent_missing', 'client_error'])('keeps %s blocked when the poller finds a healthy complete torrent', async (code) => {
    const { entry } = await setup(mediaType, 'downloading', code);
    const { hash } = addDownload([entry], mediaType);
    const before = structuredClone(entry);

    await pipe!.poller.tick();

    expect(pipe!.poller.transfer(hash)).toMatchObject({ complete: true, stale: false });
    expect(entry).toEqual(before);
    expect(work()).toEqual([]);
    expect(pipe!.db.data.files).toEqual({});
  });

  it('does not complete a blocked target when library verification finds a file', async () => {
    const { item, entry } = await setup(mediaType);
    const folder = mediaType === 'movie' ? 'Movie Name (2019)' : 'Show Name (2020)/Season 01';
    const filename = mediaType === 'movie' ? 'Movie Name (2019).mkv' : 'Show Name - S01E01.mkv';
    item.folder = mediaType === 'movie' ? folder : 'Show Name (2020)';
    const path = join(mediaType === 'movie' ? pipe!.folders.movies : pipe!.folders.tv, folder);
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, filename), 'existing-video');
    const before = structuredClone(entry);
    const handler = libraryVerifyHandler({ queue: pipe!.queue, clients: createClients(), finder: pipe!.finder, events: pipe!.events, enqueue });
    const job = requestVerification(enqueue, item.key, {})!;

    await handler.run(job, signal());

    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(entry).toEqual(before);
    expect(Object.values(pipe!.db.data.jobs).some((job) => job.type === 'queue.search' || job.type === 'import.run')).toBe(false);
  });

  it('does not attach a backup torrent to a blocked target during verification', async () => {
    const { item, entry } = await setup(mediaType, 'fetching', 'pack_partial');
    const { hash } = addDownload([], mediaType);
    const before = structuredClone(entry);
    const handler = libraryVerifyHandler({ queue: pipe!.queue, clients: createClients(), finder: pipe!.finder, events: pipe!.events, enqueue });
    const job = requestVerification(enqueue, item.key, {
      downloads: [{ hash, episodes: mediaType === 'movie' ? [] : [{ season: 1, number: 1 }], at: 1, id: 1, failed: false }],
    })!;

    await handler.run(job, signal());

    expect(entry).toEqual(before);
    expect(Object.values(pipe!.db.data.jobs).some((job) => job.type === 'queue.search' || job.type === 'import.run')).toBe(false);
  });

  it('does not complete a blocked target through an open import journal', async () => {
    const { item, entry } = await setup(mediaType);
    const { hash } = addDownload([entry], mediaType);
    pipe!.queue.resolve(entry, 'importing', 'fixture: import starts');
    const crash = new Error('stop after stage');
    let stopped = false;
    const handler = importRunHandler({
      queue: pipe!.queue, events: pipe!.events, clients: createClients(), save: async () => {},
      probe: async () => ({ ok: true, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] }),
      checkDelayMs: 0,
      afterStep: (state) => {
        if (state !== 'staged' || stopped) return;
        stopped = true;
        throw crash;
      },
    });
    const job = enqueue({ type: 'import.run', payload: { hash } });
    await expect(handler.run(job, signal())).rejects.toThrow();
    expect(Object.values(pipe!.db.data.imports)).toHaveLength(1);
    pipe!.queue.block(entry, { code: 'permission_denied' }, 'human intervention is necessary');
    const before = structuredClone(entry);

    await handler.run(job, signal());

    expect(entry).toEqual(before);
    expect(item.fileId).toBeNull();
    expect(item.episodes.every((episode) => episode.fileId === null)).toBe(true);
    expect(pipe!.db.data.files).toEqual({});
  });
});

describe('selected target authorization', () => {
  it('retries only the selected episode of a complete shared torrent', async () => {
    const { item, entries } = await setup('tv', 'importing', 'file_not_found', 2);
    const { hash } = addDownload(entries, 'tv');
    const [selected, sibling] = entries as [QueueEntry, QueueEntry];
    const before = structuredClone(sibling);
    api = await pipe!.api();

    expect((await api.post('/queue/actions', { action: 'retry', ids: [selected.id] })).status).toBe(200);
    expect(selected.state.kind).toBe('importing');
    expect(sibling).toEqual(before);

    pipe!.db.data.queuePaused = false;
    await until(() => stageOf(selected) === 'available');
    await pipe!.poller.tick();
    await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run'));
    pipe!.worker.enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
    await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run'));

    expect(sibling).toEqual(before);
    expect(item.episodes[0]!.fileId).not.toBeNull();
    expect(item.episodes[1]!.fileId).toBeNull();
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(pipe!.qbit.torrents.size).toBe(1);
  });

  it('does not use an old retry attempt as authorization for a sibling', async () => {
    const { entries } = await setup('tv', 'downloading', 'client_error', 2);
    addDownload(entries, 'tv');
    const [selected, sibling] = entries as [QueueEntry, QueueEntry];
    pipe!.queue.retryAttempt(sibling, 'retry');
    const before = structuredClone(sibling);
    api = await pipe!.api();

    expect((await api.post('/queue/actions', { action: 'retry', ids: [selected.id] })).status).toBe(200);
    pipe!.db.data.queuePaused = false;
    await vi.waitFor(() => expect(selected.state).toEqual({ kind: 'available' }));

    expect(sibling).toEqual({ ...before, revision: sibling.revision });
    expect(Object.values(pipe!.db.data.files)).toHaveLength(1);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it('returns a selected movie to import checks without another search or download', async () => {
    const { item, entry } = await setup('movie');
    const other = movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', manualRelease: true });
    pipe!.db.data.titles[other.key] = other;
    const sibling = pipe!.queue.ensure(other.key, null, null);
    pipe!.queue.request(sibling, 'attached download');
    pipe!.queue.enter(sibling, 'importing', 'download complete');
    pipe!.queue.block(sibling, { code: 'file_not_found' }, 'import blocked');
    addDownload([entry, sibling], 'movie');
    const before = structuredClone(sibling);
    api = await pipe!.api();

    expect((await api.post('/queue/actions', { action: 'retry', ids: [entry.id] })).status).toBe(200);
    expect(entry.state.kind).toBe('importing');
    expect(item.fileId).toBeNull();
    expect(pipe!.db.data.files).toEqual({});

    pipe!.db.data.queuePaused = false;
    await until(() => stageOf(entry) === 'available');

    expect(item.fileId).not.toBeNull();
    expect(sibling).toEqual(before);
    expect(other.fileId).toBeNull();
    expect(entry.history.some((event) => event.stage === 'importing')).toBe(true);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(pipe!.qbit.torrents.size).toBe(1);
  });
});

describe.each(['movie', 'tv'] as const)('technical retry contract: %s', (mediaType) => {
  it.each([
    { attempts: 1, kind: 'outage', blocked: false },
    { attempts: 5, kind: 'outage', blocked: false },
    { attempts: 6, kind: 'outage', blocked: true },
    { attempts: 1, kind: 'invalid_input', blocked: true },
  ] as const)('keeps fetch active until its error is final: $kind, attempt $attempts', async ({ attempts, kind, blocked }) => {
    const { entry } = await setup(mediaType, 'fetching', 'indexer_unavailable');
    const release = structuredClone(selectRelease(entry));
    beginFetch(entry);
    const history = entry.history.length;
    const message = 'The indexer did not return the torrent.';
    const error = kind === 'outage' ? new IndexerError('unavailable', message) : new JobError(kind, message);
    vi.spyOn(pipe!.indexers, 'download').mockRejectedValueOnce(error);
    const job = fetchJob(entry);
    job.attempts = attempts - 1;

    pipe!.db.data.queuePaused = false;
    await vi.waitFor(() => expect(pipe!.db.data.jobs[job.id]).toMatchObject({
      state: blocked ? 'failed' : 'waiting', attempts, lastError: { kind, message },
    }));
    await pipe!.worker.drain();

    expect.soft(turnOf(entry).state).toMatchObject(blocked ? { kind: 'blocked', at: 'fetching' } : { kind: 'fetching' });
    expect.soft(entry.history.slice(history).some((event) => event.state.kind === 'blocked')).toBe(blocked);
    expect(entry.release).toMatchObject({ guid: release.guid, title: release.title, link: release.link });
    expect(entry.attempt).toBe(1);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.qbit.torrents.size).toBe(0);
  });

  it.each([
    { attempts: 1, kind: 'outage', blocked: false },
    { attempts: 7, kind: 'uncertain', blocked: false },
    { attempts: 8, kind: 'outage', blocked: true },
    { attempts: 1, kind: 'invalid_input', blocked: true },
  ] as const)('keeps send active until its error is final: $kind, attempt $attempts', async ({ attempts, kind, blocked }) => {
    const { entry } = await setup(mediaType, 'fetching', 'client_unreachable');
    selectRelease(entry);
    beginFetch(entry);
    const torrent = prepared(entry);
    const before = structuredClone({ release: torrent.release, source: torrent.source, matches: torrent.matches });
    await pipe!.worker.pause();
    pipe!.db.data.queuePaused = false;
    const history = entry.history.length;
    const error = new JobError(kind, 'The client did not accept the torrent.');
    const deps = grabDeps();
    const client = deps.clients.get('client-1')!.api;
    const add = vi.spyOn(client, 'add').mockResolvedValue(undefined);
    if (kind !== 'uncertain') vi.spyOn(client, 'find').mockRejectedValueOnce(error);
    const handler = queueSendHandler(deps);
    const job = sendJob(entry, torrent);
    job.attempts = attempts;

    await expect(handler.run(job, signal())).rejects.toMatchObject({ kind });

    expect(entry.state).toMatchObject(blocked ? { kind: 'blocked', at: 'fetching' } : { kind: 'fetching' });
    expect(turnOf(entry).state).toMatchObject(blocked ? { kind: 'blocked', at: 'fetching' } : { kind: 'fetching' });
    expect(entry.history.slice(history).some((event) => event.state.kind === 'blocked')).toBe(blocked);
    expect(turnOf(entry).selected[torrent.hash]).toMatchObject(before);
    expect(add).toHaveBeenCalledTimes(kind === 'uncertain' ? 1 : 0);
    expect(entry.attempt).toBe(1);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it.each(['queue.search', 'queue.grab', 'queue.send', 'queue.retry'] as const)('ignores a stale %s job for a blocked target', async (type) => {
    const { entry } = await setup(mediaType, 'fetching', 'grab_failed');
    selectRelease(entry);
    const item = turnOf(entry);
    pipe!.queue.transitionItem(item, { kind: 'fetching' });
    pipe!.queue.transitionItem(item, { kind: 'blocked', at: 'fetching', problem: { code: 'grab_failed' } });
    const torrent = prepared(entry);
    const before = structuredClone(entry);
    const itemBefore = structuredClone(item);
    const deps = grabDeps();
    const download = vi.spyOn(deps.indexers, 'download');
    const find = vi.spyOn(deps.clients, 'find');
    const add = vi.spyOn(deps.clients.get('client-1')!.api, 'add');
    const handler = type === 'queue.search' ? queueSearchHandler(pipe!.finder)
      : type === 'queue.grab' ? queueGrabHandler(deps)
      : type === 'queue.send' ? queueSendHandler(deps)
      : queueRetryHandler({ ...deps, events: pipe!.events });
    const job = type === 'queue.search' ? fetchJob(entry) : type === 'queue.send' ? sendJob(entry, torrent) : enqueue({ type, payload: { entryIds: [entry.id] } });
    const jobs = structuredClone(pipe!.db.data.jobs);

    await handler.run(job, signal());

    expect(entry).toEqual(before);
    expect(item).toEqual(itemBefore);
    expect(pipe!.db.data.jobs).toEqual(jobs);
    expect(download).not.toHaveBeenCalled();
    expect(find).not.toHaveBeenCalled();
    expect(add).not.toHaveBeenCalled();
    expect(pipe!.tracker.state.searches).toEqual([]);
  });

  it.each(['torrent metadata', 'magnet metadata', 'send reconciliation'] as const)('ignores the old %s result after an explicit selection at the same stage', async (boundary) => {
    const { entry } = await setup(mediaType, 'fetching', 'grab_failed');
    const ref = selectRelease(entry);
    beginFetch(entry);
    const deps = grabDeps();
    const finder = createFinder(deps);
    const client = deps.clients.get('client-1')!.api;
    let release!: () => void;
    let started = false;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const hold = async <T,>(result: T) => {
      started = true;
      await gate;
      return result;
    };
    let job;
    if (boundary === 'send reconciliation') {
      const torrent = prepared(entry);
      Object.assign(torrent, { status: 'uncertain', clientId: 'client-1', addTag: 'original' });
      const { hash } = addDownload([], mediaType, false);
      pipe!.qbit.torrents.set(torrent.hash, { ...pipe!.qbit.torrents.get(hash)!, hash: torrent.hash, tags: 'original' });
      const found = await client.find(torrent.hash);
      expect(found).not.toBeNull();
      vi.spyOn(client, 'find').mockImplementationOnce(() => hold(found));
      await pipe!.worker.pause();
      pipe!.db.data.queuePaused = false;
      job = sendJob(entry, torrent);
    } else {
      if (boundary === 'torrent metadata') {
        vi.spyOn(deps.indexers, 'download').mockImplementationOnce(() => hold({ torrent: makeTorrent(ref.title) }));
      } else {
        vi.spyOn(deps.indexers, 'download').mockResolvedValueOnce({ magnet: `magnet:?xt=urn:btih:${hashOf(ref.title)}` });
        vi.spyOn(client, 'metadataFiles').mockImplementationOnce(() => hold([`${ref.title}/Show.Name.S01E01.mkv`]));
      }
      job = fetchJob(entry);
    }
    const handler = boundary === 'send reconciliation' ? queueSendHandler(deps) : queueSearchHandler(finder);
    job.state = 'running';
    const running = Promise.resolve(handler.run(job, signal())).then(() => ({ ok: true }), (error: unknown) => ({ error }));
    try {
      await vi.waitFor(() => expect(started).toBe(true));
      pipe!.queue.block(entry, { code: 'file_unmapped' }, 'the source needs a human decision');
      const name = mediaType === 'movie' ? 'Movie.Name.2019.1080p.WEB-DL-NEW' : 'Show.Name.S01E01.1080p.WEB-DL-NEW';
      delete pipe!.db.data.jobs[job.id];
      const replacement = rawRelease(name);
      const want = finder.wantForRelease(pipe!.db.data.titles[entry.titleKey]!, replacement, entry.season ?? undefined, entry.number ?? undefined)!;
      expect(finder.grabManual([entry], replacement, want)).toEqual({ reserved: true });
      if (boundary === 'send reconciliation') {
        const next = prepared(entry, name);
        sendJob(entry, next);
      }
      const before = structuredClone({ entry, item: turnOf(entry), jobs: pipe!.db.data.jobs });
      release();
      expect(await running).toEqual({ ok: true });
      expect.soft({ entry, item: turnOf(entry), jobs: pipe!.db.data.jobs }).toEqual(before);
    } finally {
      release();
      await running;
    }
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
  });

  it('retries fetch at fetching with the selected release', async () => {
    const { entry } = await setup(mediaType, 'fetching', 'indexer_unavailable');
    const release = structuredClone(selectRelease(entry));
    pipe!.queue.transitionItem(turnOf(entry), { kind: 'fetching' });
    pipe!.queue.transitionItem(turnOf(entry), { kind: 'blocked', at: 'fetching', problem: { code: 'indexer_unavailable' } });
    await runFetchRetry(entry);
    expect(entry.release).toMatchObject({ title: release.title, guid: release.guid, link: release.link });
    expect(turnOf(entry).state.kind).toBe('fetching');
    expect(Object.values(turnOf(entry).selected)).toMatchObject([{ status: 'prepared', release: { title: release.title } }]);
    expect(work().filter((job) => job.type === 'queue.send')).toHaveLength(1);
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([release.title]);
  });

  it('keeps a selected fetch blocked on a malformed torrent instead of another search', async () => {
    const { entry } = await setup(mediaType, 'fetching', 'indexer_unavailable');
    const release = structuredClone(selectRelease(entry));
    pipe!.tracker.state.items[0]!.bad = true;
    pipe!.queue.transitionItem(turnOf(entry), { kind: 'fetching' });
    pipe!.queue.transitionItem(turnOf(entry), { kind: 'blocked', at: 'fetching', problem: { code: 'indexer_unavailable' } });
    await runFetchRetry(entry);

    expect(turnOf(entry).state).toMatchObject({ kind: 'blocked', at: 'fetching', problem: { code: 'all_rejected' } });
    expect(turnOf(entry).search?.rejected).toContainEqual(expect.objectContaining({ guid: release.guid, reasons: expect.arrayContaining([REJECTION_TEXT.invalid_torrent]) }));
    expect(work().some((job) => job.type === 'queue.send')).toBe(false);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([release.title]);
  });

  it('retries send through the sender and reuses a torrent that the client received', async () => {
    const { entry } = await setup(mediaType, 'fetching', 'client_unreachable');
    selectRelease(entry);
    beginFetch(entry);
    const torrent = prepared(entry);
    const { hash } = torrent;
    Object.assign(torrent, { status: 'uncertain', clientId: 'client-1', addTag: 'accepted-before-reply' });
    const clientTorrent = addDownload([], mediaType, false);
    pipe!.qbit.torrents.set(hash, { ...pipe!.qbit.torrents.get(clientTorrent.hash)!, hash, tags: torrent.addTag! });
    pipe!.queue.block(entry, { code: 'client_unreachable' }, 'send failed');
    pipe!.queue.transitionItem(turnOf(entry), { kind: 'blocked', at: 'fetching', problem: { code: 'client_unreachable' } });
    const { retry } = createRetry({ queue: pipe!.queue, enqueue });

    retry(entry);

    expect(entry.state).toEqual({ kind: 'fetching' });
    expect(turnOf(entry).selected[hash]?.status).toBe('uncertain');
    expect(work()).toHaveLength(1);
    expect(work()[0]).toMatchObject({ type: 'queue.send', payload: { itemId: turnOf(entry).id, hash, entryIds: [entry.id] } });
    await pipe!.worker.pause();
    pipe!.db.data.queuePaused = false;
    await queueSendHandler(grabDeps()).run(work()[0]!, signal());
    expect(entry.state.kind).toBe('downloading');
    expect(entry.transferHash).toBe(hash);
    expect(turnOf(entry).selected[hash]?.status).toBe('accepted');
    expect(pipe!.qbit.calls.some((call) => call.path === 'torrents/info')).toBe(true);
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
  });

  it.each(['absent', 'error'] as const)('keeps a download check blocked when the torrent is %s', async (status) => {
    const { entry } = await setup(mediaType, 'downloading', status === 'absent' ? 'torrent_missing' : 'client_error');
    const release = selectRelease(entry);
    const { hash } = addDownload([entry], mediaType, false);
    release.infoHash = hash;
    if (status === 'absent') pipe!.qbit.torrents.delete(hash);
    else pipe!.qbit.progress(hash, 0.5, 'missingFiles');
    const before = structuredClone({ release: entry.release, source: entry.source, attempt: entry.attempt });
    const history = entry.history.length;
    const { retry } = createRetry({ queue: pipe!.queue, enqueue });

    retry(entry);
    const jobs = [...work()];
    const deps = grabDeps();
    const handlers = {
      'queue.retry': queueRetryHandler({ ...deps, events: pipe!.events }),
      'queue.grab': queueGrabHandler(deps),
      'queue.send': queueSendHandler(deps),
    };
    for (const job of jobs) {
      const handler = handlers[job.type as keyof typeof handlers];
      expect(handler).toBeDefined();
      await handler.run(job, signal());
    }

    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'downloading', problem: { code: status === 'absent' ? 'torrent_missing' : 'client_error' } });
    expect(entry.release).toEqual(before.release);
    expect(entry.source).toEqual(before.source);
    expect(entry.history.slice(history).every((event) => event.state.kind === 'blocked')).toBe(true);
    expect(work().some((job) => ['queue.search', 'queue.grab', 'queue.send', 'import.run'].includes(job.type))).toBe(false);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/add')).toEqual([]);
  });
});

describe.each(['movie', 'tv'] as const)('local import retry: %s', (mediaType) => {
  it('repeats import.local for the selected target without a hash', async () => {
    const { entry, entries } = await setup(mediaType, 'importing', 'file_unmapped', mediaType === 'tv' ? 2 : 1);
    const sibling = entries[1] ? structuredClone(entries[1]) : null;
    const { retry } = createRetry({ queue: pipe!.queue, enqueue });

    retry(entry);

    expect(entry.state).toEqual({ kind: 'importing' });
    expect(entry.transferHash).toBeNull();
    const jobs = Object.values(pipe!.db.data.jobs).filter((job) => job.type === 'import.local');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toEqual({ titleKey: entry.titleKey, entryIds: [entry.id], localOnly: true });
    expect(work()).toEqual([]);
    if (sibling) expect(entries[1]).toEqual(sibling);
  });

  it.each(['absent', 'unknown'] as const)('keeps the local import stuck when its file is %s, without a client attachment', async (status) => {
    const { item, entry } = await setup(mediaType, 'importing', 'file_unmapped');
    item.folder = mediaType === 'movie' ? 'Movie Name (2019)' : 'Show Name (2020)';
    if (status === 'unknown') {
      const folder = join(mediaType === 'movie' ? pipe!.folders.movies : pipe!.folders.tv, item.folder);
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'Unassigned One.mkv'), 'unknown-one');
      writeFileSync(join(folder, 'Unassigned Two.mkv'), 'unknown-two');
    }
    const { name, hash } = addDownload([], mediaType, false);
    pipe!.qbit.setFiles(hash, [{ name: `${name}/${mediaType === 'movie' ? 'Movie.mkv' : 'Show.Name.S01E01.mkv'}`, size: 1000, progress: 0.5 }]);
    pipe!.queue.resolve(entry, 'importing', 'retry import');
    const job = enqueue({ type: 'import.local', payload: { titleKey: item.key, entryIds: [entry.id], localOnly: true } });

    await importLocalHandler({ queue: pipe!.queue, clients: createClients() }).run(job, signal());

    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing' });
    expect(entry.transferHash).toBeNull();
    expect(entry.release).toBeNull();
    expect(entry.completedAt).toBeNull();
    expect(work()).toEqual([]);
    expect(pipe!.tracker.state.searches).toEqual([]);
    expect(pipe!.tracker.state.downloads).toEqual([]);
    expect(pipe!.qbit.calls.filter((call) => call.path === 'torrents/info' || call.path === 'torrents/add')).toEqual([]);
  });
});
