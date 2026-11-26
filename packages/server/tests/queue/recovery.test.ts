import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { open, set } from '../../src/core/db.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { itemFor } from '../../src/library/downloads/queue.ts';
import { unfinishedImports } from '../../src/library/imports/importer.ts';
import { infoHashOf } from '../../src/library/grab/torrent.ts';
import type { Data, QueueEntry, ReleaseRef } from '../../src/types.ts';
import { episode, movie, NOW, release, title } from '../helpers/test-fixtures.ts';
import { hashOf, makeTorrent, MIB, startPipeline } from '../helpers/test-pipeline.ts';

type Pipeline = Awaited<ReturnType<typeof startPipeline>>;
let pipe: Pipeline | undefined;
let api: Awaited<ReturnType<Pipeline['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  api = pipe = undefined;
  vi.unstubAllEnvs();
  vi.useRealTimers();
});

async function start(options?: Parameters<typeof startPipeline>[0]) {
  vi.setSystemTime(NOW);
  const pipeline = pipe = await startPipeline(options);
  pipeline.db.data.queuePaused = true;
  const app = api = await pipeline.api();
  return { pipeline, app };
}

async function reload(pipeline: Pipeline, legacy = false) {
  await pipeline.worker.drain();
  await pipeline.poller.pause();
  const file = join(pipeline.dir, 'db.json');
  vi.stubEnv('NODE_ENV', 'production');
  try {
    if (legacy) {
      const { owner, sessions, roots, titles, indexers, downloadClients, files, imports, sentTorrents, queue, queuePaused, jobs, jobSeq, torrents } = pipeline.db.data;
      writeFileSync(file, JSON.stringify({ schemaVersion: 9, owner, sessions, roots, titles, indexers, downloadClients, files, imports, sentTorrents, queue, queuePaused, jobs, jobSeq, torrents }));
    } else {
      const disk = await open(file);
      disk.data = pipeline.db.data;
      await disk.write();
    }
    const loaded = await open(file);
    await loaded.write();
    const before = [file, join(pipeline.dir, 'queue.json')].map((path) => JSON.parse(readFileSync(path, 'utf8')));
    const again = await open(file);
    await again.write();
    expect([file, join(pipeline.dir, 'queue.json')].map((path) => JSON.parse(readFileSync(path, 'utf8')))).toEqual(before);
    pipeline.db.data = again.data;
    set(pipeline.db);
  } finally {
    vi.unstubAllEnvs();
  }
}

const legacyEpisode = (titleKey: string, season: number, number: number, state: QueueEntry['state'], extra: Partial<QueueEntry> = {}): QueueEntry => ({
  id: `${titleKey}:${season}x${number}`,
  titleKey, season, number, state,
  revision: 1, createdAt: NOW - 1_000, stateSince: NOW - 1_000, phaseSince: NOW - 1_000,
  completedAt: null, clearedAt: null, priority: null,
  attempt: 12, attempts: [], history: [], search: null, release: null, transferHash: null, clientId: null,
  manualMatch: null, importResult: null,
  ...extra,
});

const ref = (pipeline: Pipeline, name: string, files: string[], kind: ReleaseRef['kind']): ReleaseRef => ({
  ...release(name, { infoHash: hashOf(name, files), link: `http://127.0.0.1:${pipeline.tracker.port}/1/download?file=${encodeURIComponent(name)}` }),
  indexerName: 'Tracker', kind, manual: false,
});
const adds = (pipeline: Pipeline) => pipeline.qbit.calls.filter(({ path }) => path === 'torrents/add');

describe('persisted queue recovery', () => {
  it('coalesces matching legacy search jobs without merging an explicit search of other release seasons', async () => {
    const { pipeline } = await start();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
    pipeline.db.data.titles[series.key] = series;
    const [first, second, third] = [1, 2, 3].map((number) => legacyEpisode(series.key, 1, number, { kind: 'queued' }));
    pipeline.db.data.queue = Object.fromEntries([first!, second!, third!].map((entry) => [entry.id, entry]));
    const search = { titleKey: series.key, season: 1 };
    enqueue({ type: 'queue.search', runAt: NOW + 100, payload: { ...search, entryIds: [first!.id] } });
    enqueue({ type: 'queue.search', runAt: NOW + 200, payload: { ...search, entryIds: [second!.id], otherSeasons: true, fresh: true } });
    enqueue({ type: 'queue.search', runAt: NOW + 300, payload: { ...search, entryIds: [third!.id] } });
    await reload(pipeline, true);

    const jobs = Object.values(pipeline.db.data.jobs).filter((job) => job.type === 'queue.search');
    expect(jobs).toHaveLength(2);
    expect(jobs).toEqual(expect.arrayContaining([
      expect.objectContaining({ runAt: NOW + 100, payload: expect.objectContaining({ ...search, entryIds: [first!.id, third!.id] }) }),
      expect.objectContaining({ runAt: NOW + 200, payload: expect.objectContaining({ ...search, entryIds: [second!.id], otherSeasons: true, fresh: true }) }),
    ]));
    expect(jobs.filter(({ payload }) => (payload as { otherSeasons?: boolean }).otherSeasons)).toHaveLength(1);
  });

  it('does not charge a completed empty round again if the worker replays it after reload', async () => {
    const { pipeline } = await start();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1)] });
    pipeline.db.data.titles[series.key] = series;
    pipeline.finder.requestSearch(series.key, { season: 1 });
    const id = 'tv:1:1x1';
    const item = () => itemFor(pipeline.queue.get(id)!)!;
    const due = NOW + 60 * 60_000;
    expect(pipeline.queue.transitionItem(item(), { kind: 'searching' })).toBe(true);
    expect(pipeline.queue.emptySearch(item(), 'first', [id], due)).toBe(true);
    await reload(pipeline);

    expect(item()).toMatchObject({ state: { kind: 'waiting', outcome: 'no_results' }, nextAt: due, emptySearches: { [id]: 1 } });
    vi.setSystemTime(due);
    expect(pipeline.queue.transitionItem(item(), { kind: 'searching' })).toBe(true);
    expect(pipeline.queue.emptySearch(item(), 'first', [id], due + 60 * 60_000)).toBe(false);
    expect(item().emptySearches[id]).toBe(1);
    expect(pipeline.queue.emptySearch(item(), 'second', [id], due + 60 * 60_000)).toBe(true);
    expect(item()).toMatchObject({ state: { kind: 'waiting', outcome: 'no_results' }, emptySearches: { [id]: 2 } });
  });

  it('reconciles a real add after the client accepts it but its reply never reaches the worker', async () => {
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    const hash = hashOf(name);
    let beforeReply: Data | undefined;
    let interrupted: Promise<boolean> | undefined;
    const probe = vi.fn(async () => ({ ok: true as const, durationSeconds: 2700, container: 'matroska', videoCodec: 'h264', audioLanguages: ['eng'] }));
    const { pipeline, app } = await start({
      probe,
      onAcquisition(event) {
        if (event.type !== 'add' || event.hash !== hash || beforeReply) return;
        beforeReply = structuredClone(pipeline.db.data);
        interrupted = pipeline.worker.pause();
      },
    });
    await pipeline.poller.pause();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipeline.db.data.titles[film.key] = film;
    pipeline.tracker.state.items = [{ title: name, size: 100 * 120 * MIB }];
    pipeline.qbit.control.swallowAdds = 1;
    pipeline.db.data.queuePaused = false;
    pipeline.finder.requestSearch(film.key);

    await vi.waitFor(() => expect(pipeline.qbit.torrents.has(hash)).toBe(true));
    expect(await interrupted).toBe(true);
    expect(beforeReply).toBeDefined();
    expect(adds(pipeline)).toHaveLength(1);
    pipeline.db.data = beforeReply!;
    await reload(pipeline);

    vi.setSystemTime(NOW + 60_001);
    pipeline.finder.sweep();
    pipeline.poller.start();
    pipeline.worker.resume();
    const detail = async () => (await app.get(`/queue/entries/${film.key}`)).body.entry;
    await vi.waitFor(async () => expect(await detail()).toMatchObject({ status: 'downloading', transfer: { hash } }));
    expect(adds(pipeline)).toHaveLength(1);
    expect(pipeline.tracker.state.searches).toHaveLength(1);
    expect(pipeline.tracker.state.downloads).toEqual([name]);

    pipeline.complete(name, { [`${name}.mkv`]: 'the-film' }, hash);
    await vi.waitFor(async () => expect(await detail()).toMatchObject({ status: 'available' }));
    expect(Object.values(pipeline.db.data.files)).toHaveLength(1);
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('keeps a prepared release in Fetching across a reload with no free slot, then submits it once', async () => {
    const { pipeline, app } = await start();
    const first = movie({ rootId: 'movie', manualRelease: true });
    const second = movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', manualRelease: true, meta: { ...first.meta, tmdbId: 3, title: 'Other Movie', originalTitle: 'Other Movie' } });
    pipeline.db.data.titles = { [first.key]: first, [second.key]: second };
    pipeline.db.data.downloadClients[0]!.maxDownloads = 1;
    const firstName = 'Movie.Name.2019.1080p.BluRay-GRP';
    const secondName = 'Other.Movie.2019.1080p.BluRay-GRP';
    pipeline.tracker.state.items = [firstName, secondName].map((title) => ({ title, size: 100 * 120 * MIB, category: 2040 }));
    const detail = async (key: string) => (await app.get(`/queue/entries/${key}`)).body.entry;

    pipeline.db.data.queuePaused = false;
    pipeline.finder.requestSearch(first.key);
    await vi.waitFor(async () => expect(await detail(first.key)).toMatchObject({ status: 'downloading' }));
    pipeline.finder.requestSearch(second.key);
    await vi.waitFor(() => expect(pipeline.tracker.state.downloads).toEqual([firstName, secondName]));
    await reload(pipeline);

    pipeline.finder.sweep();
    pipeline.poller.start();
    pipeline.worker.resume();
    vi.setSystemTime(NOW + 1);
    await vi.waitFor(() => expect(pipeline.worker.heartbeat).toBeGreaterThan(NOW));
    await pipeline.worker.drain();
    expect.soft(await detail(second.key)).toMatchObject({ status: 'fetching', release: { title: secondName }, transfer: null });
    expect(adds(pipeline)).toHaveLength(1);
    expect(pipeline.tracker.state.downloads).toEqual([firstName, secondName]);
    const searches = pipeline.tracker.state.searches.length;

    pipeline.complete(firstName, { [`${firstName}.mkv`]: 'the-film' });
    pipeline.worker.resume();
    await vi.waitFor(async () => expect(await detail(second.key)).toMatchObject({ status: 'downloading' }));
    expect(adds(pipeline)).toHaveLength(2);
    expect(pipeline.qbit.receivedTorrents.map(infoHashOf)).toEqual([hashOf(firstName), hashOf(secondName)]);
    expect(pipeline.tracker.state.searches).toHaveLength(searches);
    expect(pipeline.tracker.state.downloads).toEqual([firstName, secondName]);
  });

  it('keeps the missing episode delay across reload and stops after the third completed empty round', async () => {
    const { pipeline, app } = await start();
    const series = title({ rootId: 'tv', episodes: [episode(1, 2)] });
    pipeline.db.data.titles[series.key] = series;
    pipeline.finder.requestSearch(series.key, { season: 1, number: 2 });
    pipeline.db.data.queuePaused = false;
    const detail = async () => (await app.get(`/queue/groups/${series.key}?season=1`)).body;
    const episodeQueries = () => pipeline.tracker.state.searches.filter((url) => Number(url.searchParams.get('ep')) === 2);

    async function waitForDelay(after: number) {
      let due = 0;
      await vi.waitFor(async () => {
        const body = await detail();
        expect(body.group.status).toBe('not_found');
        due = body.group.nextAt ?? 0;
        expect(due).toBeGreaterThan(after);
      });
      return due;
    }

    const second = await waitForDelay(NOW);
    expect(episodeQueries()).toHaveLength(1);
    vi.setSystemTime(second);
    pipeline.finder.sweep();
    const third = await waitForDelay(second);
    expect(episodeQueries()).toHaveLength(2);
    await reload(pipeline);
    expect((await detail()).group.nextAt).toBe(third);

    const film = movie({ rootId: 'movie', manualRelease: true });
    pipeline.db.data.titles[film.key] = film;
    vi.setSystemTime(third - 1);
    pipeline.finder.requestSearch(film.key);
    pipeline.finder.sweep();
    pipeline.worker.resume();
    await vi.waitFor(() => expect(pipeline.tracker.state.searches.some((url) => url.searchParams.get('t') === 'movie')).toBe(true));
    expect(episodeQueries()).toHaveLength(2);

    vi.setSystemTime(third);
    pipeline.finder.sweep();
    await vi.waitFor(() => expect(episodeQueries()).toHaveLength(3));
    await pipeline.worker.drain();
    expect.soft((await detail()).group).toMatchObject({ status: 'stuck', tabs: ['stuck'] });
    expect.soft((await app.get('/queue?stage=stuck')).body.items).toContainEqual(expect.objectContaining({ titleKey: series.key, season: 1 }));
    expect.soft((await app.get('/queue?stage=searching')).body.items).not.toContainEqual(expect.objectContaining({ titleKey: series.key }));
    expect.soft((await app.get('/queue?stage=queued')).body.items).not.toContainEqual(expect.objectContaining({ titleKey: series.key }));

    vi.setSystemTime(third + (third - second) + 1);
    pipeline.finder.sweep();
    pipeline.worker.resume();
    await vi.waitFor(() => expect(pipeline.tracker.state.searches.filter((url) => url.searchParams.get('t') === 'movie')).toHaveLength(2));
    await pipeline.worker.drain();
    expect.soft(episodeQueries()).toHaveLength(3);
    expect(adds(pipeline)).toEqual([]);
  });

  it('migrates a missing-client block to a configuration wait and resumes the saved source once', async () => {
    const { pipeline, app } = await start();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1)] });
    pipeline.db.data.titles[series.key] = series;
    const name = 'Show.Name.S01E01.1080p.WEB-DL-GRP';
    const files = ['Show.Name.S01E01.mkv'];
    const selected = ref(pipeline, name, files, 'single');
    const hash = selected.infoHash!;
    const entry = legacyEpisode(series.key, 1, 1, { kind: 'blocked', at: 'waiting_slot', problem: { code: 'client_missing' } }, {
      release: selected, transferHash: hash, source: { torrent: true }, numbering: { revision: 0, ranges: [] },
    });
    const [client] = pipeline.db.data.downloadClients;
    pipeline.db.data.downloadClients = [];
    pipeline.db.data.queue[entry.id] = entry;
    pipeline.db.data.torrents[hash] = makeTorrent(name, files).toString('base64');
    await reload(pipeline, true);

    const group = async () => (await app.get(`/queue/groups/${series.key}?season=1`)).body.group;
    expect.soft(await group()).toMatchObject({ status: 'fetching' });
    expect.soft((await app.get('/queue?stage=stuck')).body.total).toBe(0);
    expect(pipeline.tracker.state.searches).toEqual([]);
    expect(pipeline.tracker.state.downloads).toEqual([]);
    expect(adds(pipeline)).toEqual([]);

    pipeline.db.data.queuePaused = false;
    pipeline.finder.sweep();
    pipeline.worker.resume();
    vi.setSystemTime(NOW + 1);
    await vi.waitFor(() => expect(pipeline.worker.heartbeat).toBeGreaterThan(NOW));
    await pipeline.worker.drain();
    expect.soft(await group()).toMatchObject({ status: 'fetching' });
    expect(adds(pipeline)).toEqual([]);

    pipeline.db.data.downloadClients = [client!];
    pipeline.finder.sweep();
    pipeline.worker.resume();
    await vi.waitFor(async () => expect(await group()).toMatchObject({ status: 'downloading' }));
    await reload(pipeline);
    pipeline.finder.sweep();
    pipeline.worker.resume();
    vi.setSystemTime(NOW + 2);
    await vi.waitFor(() => expect(pipeline.worker.heartbeat).toBeGreaterThan(NOW + 1));
    await pipeline.worker.drain();
    expect(adds(pipeline)).toHaveLength(1);
    expect(pipeline.qbit.receivedTorrents.map(infoHashOf)).toEqual([hash]);
    expect(pipeline.tracker.state.searches).toEqual([]);
    expect(pipeline.tracker.state.downloads).toEqual([]);
  });

  it('reconciles an uncertain accepted hash and submits only the outstanding torrent after reload', async () => {
    const { pipeline, app } = await start();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
    pipeline.db.data.titles[series.key] = series;
    const pack = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const single = 'Show.Name.S01E03.1080p.WEB-DL-GRP';
    const packFiles = ['Show.Name.S01E01.mkv', 'Show.Name.S01E02.mkv'];
    const singleFiles = ['Show.Name.S01E03.mkv'];
    const accepted = ref(pipeline, pack, packFiles, 'pack');
    const outstanding = ref(pipeline, single, singleFiles, 'single');
    const acceptedHash = accepted.infoHash!;
    const outstandingHash = outstanding.infoHash!;
    const clientId = pipeline.db.data.downloadClients[0]!.id;
    const entries = [1, 2, 3].map((number) => {
      const selected = number === 3 ? outstanding : accepted;
      return legacyEpisode(series.key, 1, number, { kind: number === 3 ? 'waiting_slot' : 'sending' }, {
        release: selected, transferHash: selected.infoHash, clientId, source: { torrent: true }, numbering: { revision: 0, ranges: [] },
      });
    });
    pipeline.db.data.queue = Object.fromEntries(entries.map((entry) => [entry.id, entry]));
    pipeline.db.data.torrents[acceptedHash] = makeTorrent(pack, packFiles).toString('base64');
    pipeline.db.data.torrents[outstandingHash] = makeTorrent(single, singleFiles).toString('base64');
    pipeline.db.data.sentTorrents[acceptedHash] = NOW - 1_000;
    const oldSend = { type: 'queue.send', runAt: NOW, payload: { entryIds: [entries[0]!.id, entries[1]!.id] } };
    enqueue(oldSend);
    enqueue(oldSend);
    enqueue({ type: 'queue.send', runAt: NOW, payload: { entryIds: [entries[2]!.id] } });
    enqueue({ type: 'queue.search', runAt: NOW, payload: { titleKey: series.key, season: 1, entryIds: entries.map(({ id }) => id) } });

    pipeline.qbit.torrents.set(acceptedHash, {
      hash: acceptedHash, name: pack, size: 2_000, progress: 0.4, state: 'downloading',
      category: 'ladarr', tags: '', save_path: pipeline.folders.downloads, content_path: join(pipeline.folders.downloads, pack),
      dlspeed: 1, eta: 100, num_seeds: 1, num_leechs: 0, added_on: NOW / 1_000 - 1,
    });
    pipeline.qbit.setFiles(acceptedHash, packFiles.map((file) => ({ name: `${pack}/${file}`, size: 1000, progress: 0.4 })));

    await pipeline.poller.pause();
    const callsBeforeMigration = pipeline.qbit.calls.length;
    await reload(pipeline, true);
    expect(pipeline.qbit.calls).toHaveLength(callsBeforeMigration);
    pipeline.db.data.queuePaused = false;
    pipeline.finder.sweep();
    pipeline.poller.start();
    pipeline.worker.resume();
    const detail = async () => (await app.get(`/queue/groups/${series.key}?season=1`)).body;
    await vi.waitFor(async () => expect((await detail()).items).toMatchObject([
      { status: 'downloading', transfer: { hash: acceptedHash } },
      { status: 'downloading', transfer: { hash: acceptedHash } },
      { status: 'downloading', transfer: { hash: outstandingHash } },
    ]));

    await reload(pipeline);
    pipeline.finder.sweep();
    pipeline.poller.start();
    pipeline.worker.resume();
    await vi.waitFor(async () => expect((await detail()).group.status).toBe('downloading'));
    await pipeline.worker.drain();
    expect(adds(pipeline)).toHaveLength(1);
    expect(pipeline.qbit.receivedTorrents.map(infoHashOf)).toEqual([outstandingHash]);
    expect(pipeline.tracker.state.searches).toEqual([]);
    expect(pipeline.tracker.state.downloads).toEqual([]);
  });

  it('preserves imported files, unfinished import work, delays and user stops in legacy seasons', async () => {
    const { pipeline, app } = await start();
    const numbering = { revision: 4, ranges: [] };
    const series = title({ rootId: 'tv', numbering, episodes: [
      episode(1, 1, undefined, { fileId: 'file-1' }), episode(1, 2),
      ...[2, 3, 4, 5, 6].map((season) => episode(season, 1)),
    ] });
    pipeline.db.data.titles[series.key] = series;
    const name = 'Show.Name.S01.1080p.WEB-DL-GRP';
    const firstFile = 'Show.Name.S01E01.mkv';
    const secondFile = 'Show.Name.S01E02.mkv';
    const pack = ref(pipeline, name, [firstFile, secondFile], 'pack');
    const hash = pack.infoHash!;
    const clientId = pipeline.db.data.downloadClients[0]!.id;
    const due = NOW + 60 * 60_000;
    const importPath = `Show Name/${firstFile}`;
    const downloaded = { release: pack, transferHash: hash, clientId, numbering };
    const imported = legacyEpisode(series.key, 1, 1, { kind: 'available' }, {
      ...downloaded, completedAt: NOW - 1,
      importResult: { at: NOW - 1, ok: true, method: 'hardlink', path: importPath, validation: 'basic' },
    });
    const covers = [{ season: 1, number: 2 }];
    const importing = legacyEpisode(series.key, 1, 2, { kind: 'importing' }, {
      release: { ...pack, infoHash: null }, numbering, manualMatch: { file: secondFile, covers }, manualMatchRevision: 4,
    });
    const delayed = legacyEpisode(series.key, 2, 1, { kind: 'waiting', outcome: 'no_results' }, {
      search: { at: NOW - 1_000, indexers: [], accepted: 0, candidates: 0, nextAt: due, result: 'no_results', rejected: [], topRejections: [] },
    });
    const paused = legacyEpisode(series.key, 3, 1, { kind: 'paused', resume: 'searching', problem: null });
    const cancelled = legacyEpisode(series.key, 4, 1, { kind: 'cancelled', at: 'fetching' });
    const blocked = legacyEpisode(series.key, 5, 1, { kind: 'blocked', at: 'importing', problem: { code: 'disk_full' } });
    const linkOnly = legacyEpisode(series.key, 6, 1, { kind: 'waiting_slot' }, {
      release: { ...ref(pipeline, 'Show.Name.S06E01.1080p.WEB-DL-GRP', ['Show.Name.S06E01.mkv'], 'single'), infoHash: null },
    });
    pipeline.db.data.queue = Object.fromEntries([imported, importing, delayed, paused, cancelled, blocked, linkOnly].map((entry) => [entry.id, entry]));
    pipeline.db.data.files['file-1'] = {
      id: 'file-1', titleKey: series.key, path: importPath, sizeBytes: 1_000, mtimeMs: NOW - 1, addedAt: NOW - 1, missing: false,
      episodes: [{ season: 1, number: 1 }], download: { clientId, hash, external: false, file: firstFile },
    };
    const journalId = randomUUID();
    pipeline.db.data.imports[journalId] = {
      id: journalId, hash, titleKey: series.key, clientId, downloadBase: pipeline.folders.downloads, createdAt: NOW - 100,
      steps: [{
        entryIds: [importing.id], source: secondFile, dest: `Show Name/${secondFile}`, replaces: null,
        state: 'published', method: 'hardlink', sizeBytes: 1_000, episodes: covers, validation: 'basic',
      }],
    };
    await reload(pipeline, true);

    const detail = async (season: number) => (await app.get(`/queue/groups/${series.key}?season=${season}`)).body;
    const firstSeason = await detail(1);
    expect(firstSeason.group.status).toBe('importing');
    expect(firstSeason.items).toMatchObject([{ status: 'available', importResult: { path: importPath } }, { status: 'importing' }]);
    expect(unfinishedImports()).toEqual([hash]);
    const step = pipeline.db.data.imports[journalId]!.steps[0]!;
    expect(step).toMatchObject({ state: 'published', episodes: covers, source: secondFile });
    expect(step.entryIds).toEqual([firstSeason.items[1].id]);
    expect(pipeline.queue.get(step.entryIds[0]!)).toMatchObject({ transferHash: hash, clientId, manualMatch: { file: secondFile, covers }, manualMatchRevision: 4 });
    expect(pipeline.db.data.files['file-1']!.download).toMatchObject({ hash, clientId, file: firstFile });

    const secondSeason = await detail(2);
    expect(secondSeason.group.status).toBe('not_found');
    expect(secondSeason.group.nextAt).toBe(due);
    expect(itemFor(pipeline.queue.get(secondSeason.items[0].id)!)?.emptySearches).toEqual({});
    expect((await detail(3)).items[0].status).toBe('paused');
    expect((await detail(4)).items[0].status).toBe('cancelled');
    expect((await detail(5)).group).toMatchObject({ status: 'stuck', problem: { code: 'disk_full' } });
    expect((await detail(6)).group.status).toBe('fetching');
    expect(pipeline.tracker.state.searches).toEqual([]);
    expect(pipeline.tracker.state.downloads).toEqual([]);
    expect(adds(pipeline)).toEqual([]);
  });
});
