import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QueueState } from '@ladarr/shared/queue';
import { open, set } from '../../src/core/db.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { itemFor } from '../../src/library/downloads/queue.ts';
import { unfinishedImports } from '../../src/library/imports/importer.ts';
import { infoHashOf } from '../../src/library/grab/torrent.ts';
import type { Data, QueueEntry, QueueTorrent, ReleaseRef } from '../../src/types.ts';
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

function partiallyAvailableSeason(pipeline: Pipeline) {
  const series = title({ rootId: 'tv', episodes: [episode(1, 1, undefined, { fileId: 'first' }), episode(1, 2)] });
  pipeline.db.data.files.first = {
    id: 'first', titleKey: series.key, path: 'Show Name/S01E01.mkv', sizeBytes: 1000, mtimeMs: NOW, addedAt: NOW,
    missing: false, episodes: [{ season: 1, number: 1 }],
  };
  pipeline.db.data.titles[series.key] = series;
  return series;
}

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
    const series = partiallyAvailableSeason(pipeline);
    pipeline.finder.requestSearch(series.key, { season: 1 });
    const id = 'tv:1:1x2';
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
    const series = partiallyAvailableSeason(pipeline);
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

  it('recovers an absent season blocked by empty searches and retries without a manual action', async () => {
    const { pipeline, app } = await start();
    const series = title({ rootId: 'tv', episodes: [episode(2, 1), episode(2, 2)] });
    pipeline.db.data.titles[series.key] = series;
    const entries = pipeline.finder.requestSearch(series.key, { season: 2 });
    const turn = pipeline.queue.findItem(series.key, 2)!;
    const problem = { code: 'no_results', detail: entries[0]!.id };
    turn.state = { kind: 'blocked', at: 'searching', problem };
    for (const entry of entries) {
      turn.emptySearches[entry.id] = 3;
      entry.state = turn.state;
    }
    pipeline.db.data.jobs = {};
    await reload(pipeline);

    const detail = async () => (await app.get(`/queue/groups/${series.key}?season=2`)).body.group;
    expect(await detail()).toMatchObject({ status: 'not_found', counts: { not_found: 2 } });
    pipeline.db.data.queuePaused = false;
    pipeline.finder.sweep();
    pipeline.worker.resume();
    await vi.waitFor(() => expect(pipeline.tracker.state.searches).toHaveLength(3));
    await pipeline.worker.drain();
    const waiting = await detail();
    expect(waiting.status).toBe('not_found');
    expect(waiting.nextAt).toBeGreaterThan(NOW);
    expect(adds(pipeline)).toHaveLength(0);
  });

  const PARTIAL = 'The torrent does not contain all the requested episodes.';
  type Source = { status: QueueTorrent['status']; extra?: Partial<QueueTorrent>; manual?: boolean; state: QueueEntry['state']; client?: boolean };

  // A season as an older version saved it. Each source covers the episode of its position. The episodes after the
  // sources have no release.
  function savedSeason(pipeline: Pipeline, season: number, state: QueueState, sources: Source[], missing = 1) {
    const numbers = Array.from({ length: sources.length + missing }, (_, index) => index + 1);
    const series = pipeline.db.data.titles['tv:1'] ?? title({ rootId: 'tv' });
    series.episodes.push(...numbers.map((number) => episode(season, number)));
    pipeline.db.data.titles[series.key] = series;
    const entries = numbers.map((number) => {
      const entry = pipeline.queue.ensure(series.key, season, number);
      pipeline.queue.request(entry, 'search requested');
      entry.numbering = { revision: 0, ranges: [] };
      return entry;
    });
    const turn = pipeline.queue.findItem(series.key, season)!;
    const saved = sources.map((source, index) => {
      const entry = entries[index]!;
      const name = `Show.Name.S0${season}E0${entry.number}.1080p.WEB-DL-SAVED`;
      const files = [`Show.Name.S0${season}E0${entry.number}.mkv`];
      const release = { ...ref(pipeline, name, files, 'single'), manual: source.manual ?? false };
      const hash = release.infoHash!;
      const clientId = source.client ? pipeline.db.data.downloadClients[0]!.id : null;
      const accepted = source.status === 'accepted';
      if (!accepted) pipeline.db.data.torrents[hash] = makeTorrent(name, files).toString('base64');
      turn.selected[hash] = {
        hash, release, source: accepted ? null : { torrent: true }, numberingRevision: 0, status: source.status, clientId,
        matches: { [entry.id]: `${name}/${files[0]}` }, ...source.extra,
      };
      entry.state = source.state;
      // An episode whose files wait for the user has no torrent of its own.
      if (source.status !== 'verify') Object.assign(entry, { release, transferHash: hash, clientId, source: accepted ? null : { torrent: true } });
      return { entry, hash, release, status: source.status };
    });
    const rest = entries.slice(sources.length);
    turn.state = state;
    for (const entry of rest) entry.state = structuredClone(state);
    turn.search = { at: NOW - 1_000, indexers: [], candidates: 1, accepted: sources.length, result: 'all_rejected', topRejections: [], nextAt: null, rejected: [] };
    pipeline.db.data.jobs = {};
    return { series, turn, saved, rest };
  }

  const stop = (code: string, at: 'queued' | 'searching' | 'fetching' | 'importing') => ({ kind: 'blocked' as const, at, problem: { code } });
  const fetching = { kind: 'fetching' as const };
  const automatic: Source = { status: 'prepared', state: fetching };

  it.each([
    stop('pack_partial', 'fetching'),
    stop('pack_partial', 'queued'),
    stop('all_rejected', 'searching'),
    stop('no_results', 'searching'),
  ])('releases the automatic sources of a season saved as blocked with $problem.code at $at', async (state) => {
    const { pipeline, app } = await start();
    const { series, turn, saved, rest } = savedSeason(pipeline, 1, state, [
      automatic,
      automatic,
      { ...automatic, manual: true },
      { ...automatic, extra: { sendMapped: true } },
      { ...automatic, extra: { manualMatches: { 'Show.Name.S01E05.mkv': [{ season: 1, number: 5 }] } } },
      { status: 'verify', state },
      { status: 'uncertain', state: { kind: 'sending' }, client: true },
      { status: 'accepted', state: { kind: 'downloading' }, client: true },
    ]);
    if (state.problem.code === 'no_results') turn.emptySearches = { [rest[0]!.id]: 3 };
    await reload(pipeline);

    const loaded = pipeline.queue.findItem(series.key, 1)!;
    const released = saved.slice(0, 2);
    const kept = saved.slice(2);
    expect(loaded.state).toEqual(state);
    expect(Object.keys(loaded.selected).sort()).toEqual(kept.map(({ hash }) => hash).sort());
    for (const { id } of [...released.map(({ entry }) => entry), ...rest]) {
      expect(pipeline.queue.get(id)).toMatchObject({ release: null, transferHash: null });
      expect(pipeline.queue.get(id)!.state).toEqual(state);
    }
    for (const { entry, hash, release, status } of kept) {
      if (status !== 'verify') expect(pipeline.queue.get(entry.id)).toMatchObject({ transferHash: hash, release: { title: release.title } });
    }
    for (const { entry } of kept.slice(-2)) expect(pipeline.queue.get(entry.id)!.state).toEqual(entry.state);
    expect(loaded.search!.rejected.map(({ title }) => title).sort()).toEqual(released.map(({ release }) => release.title).sort());
    for (const row of loaded.search!.rejected) expect(row).toMatchObject({ indexerId: 1, reasons: [PARTIAL], manifestProblem: 'pack_partial' });
    for (const { hash } of released) expect(pipeline.db.data.torrents[hash]).toBeUndefined();
    for (const { hash } of kept.slice(0, -1)) expect(pipeline.db.data.torrents[hash]).toBeDefined();
    const { group } = (await app.get(`/queue/groups/${series.key}?season=1`)).body;
    expect(group.rejected).toHaveLength(2);
    expect(group.rejected.every(({ release }: { release: { selectable: boolean } }) => release.selectable)).toBe(true);
    expect(pipeline.tracker.state.searches).toEqual([]);
    expect(adds(pipeline)).toEqual([]);
  });

  it('lists the file of each released source on its rejected release after the load', async () => {
    const { pipeline, app } = await start();
    const { series, saved } = savedSeason(pipeline, 1, stop('pack_partial', 'fetching'), [automatic, automatic]);
    await reload(pipeline);

    const { group } = (await app.get(`/queue/groups/${series.key}?season=1`)).body;
    const listed = (group.rejected as { release: { title: string; matches?: Record<string, string> } }[]).map(({ release }) => [release.title, release.matches]);
    expect(Object.fromEntries(listed)).toEqual(Object.fromEntries(saved.map(({ entry, release }) =>
      [release.title, { [entry.id]: `${release.title}/Show.Name.S01E0${entry.number}.mkv` }])));
  });

  it('keeps a converted season stuck when it holds no other source and no file', async () => {
    const { pipeline } = await start();
    const state = stop('no_results', 'searching');
    const { series, turn, rest } = savedSeason(pipeline, 1, state, [automatic]);
    turn.emptySearches = { [rest[0]!.id]: 3 };
    // The reload reads the file twice, and the second read finds the season without a source.
    await reload(pipeline);

    expect(pipeline.queue.findItem(series.key, 1)).toMatchObject({ state, selected: {}, emptySearches: { [rest[0]!.id]: 3 } });
    for (const id of pipeline.queue.findItem(series.key, 1)!.entryIds) expect(pipeline.queue.get(id)!.state).toEqual(state);
  });

  it('keeps the stored copy of a released torrent that another season uses', async () => {
    const { pipeline } = await start();
    const { series, saved } = savedSeason(pipeline, 1, stop('pack_partial', 'fetching'), [automatic]);
    // A pack of two seasons: the second season still waits with the same torrent.
    const waiting = { kind: 'waiting' as const, outcome: 'no_results' as const };
    const other = savedSeason(pipeline, 2, waiting, []);
    const { hash, release } = saved[0]!;
    const [target] = other.rest;
    other.turn.selected[hash] = { hash, release, source: { torrent: true }, numberingRevision: 0, status: 'prepared', clientId: null, matches: { [target!.id]: null } };
    Object.assign(target!, { state: fetching, release, transferHash: hash, source: { torrent: true } });
    await reload(pipeline);

    expect(pipeline.queue.findItem(series.key, 1)!.selected).toEqual({});
    expect(pipeline.queue.findItem(series.key, 2)!.selected[hash]).toMatchObject({ status: 'prepared' });
    expect(pipeline.db.data.torrents[hash]).toBeDefined();
  });

  it.each([
    { name: 'a send failure', state: stop('client_rejected', 'fetching') },
    { name: 'a file that names no episode', state: stop('file_unmapped', 'fetching') },
    { name: 'a pack that the import found partial', state: stop('pack_partial', 'importing') },
    { name: 'a wait for the next search', state: { kind: 'waiting' as const, outcome: 'no_results' as const } },
  ])('keeps the automatic source of a season saved with $name', async ({ state }) => {
    const { pipeline } = await start();
    const { series, saved } = savedSeason(pipeline, 1, state, [automatic]);
    const [{ entry, hash }] = saved as [(typeof saved)[number]];
    await reload(pipeline);

    expect(pipeline.queue.findItem(series.key, 1)).toMatchObject({ state, selected: { [hash]: { status: 'prepared' } }, search: { rejected: [] } });
    expect(pipeline.queue.get(entry.id)).toMatchObject({ transferHash: hash, state: fetching });
    expect(pipeline.db.data.torrents[hash]).toBeDefined();
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
