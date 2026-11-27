import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { queueInitialHandler } from '../../src/jobs/queue-initial.ts';
import { queueSearchHandler } from '../../src/jobs/queue-search.ts';
import { createClients } from '../../src/library/downloads/client-api.ts';
import { ClientError } from '../../src/library/downloads/qbittorrent.ts';
import { createFinder } from '../../src/library/grab/finder.ts';
import { torrentsForRemoval } from '../../src/library/tools/remove.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';
import type { EpisodeRef, Job } from '../../src/types.ts';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, makeTorrent, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import { startFakeQbit } from '../helpers/test-qbit.ts';
import { createTmdbFixture, MOVIE_ID, SERIES_ID } from '../helpers/test-wholphin.ts';

type Pipe = Awaited<ReturnType<typeof startPipeline>>;
type Preview = { hash: string; version: string; files: { path: string; episodes: EpisodeRef[] }[] };
let pipe: Pipe;
let api: Awaited<ReturnType<Pipe['api']>>;
const point = (number: number, season = 1) => ({ season, number });
const film = () => movie({ rootId: 'movie', manualRelease: true });
const adds = () => pipe.qbit.calls.filter(({ path }) => path === 'torrents/add');

async function upload(key: string, file: Buffer, method = '') {
  const res = await fetch(`${api.base}/library/${key}/torrent${method ? `?method=${method}` : ''}`, {
    method: 'POST', headers: { cookie: api.cookie, 'x-csrf-token': api.csrfToken, 'content-type': 'application/x-bittorrent' },
    body: new Uint8Array(file), signal: AbortSignal.timeout(6_000),
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

async function preview(file: Buffer, method = ''): Promise<Preview> {
  const result = await upload('tv:1', file, method);
  expect(result.status, JSON.stringify(result.body)).toBe(200);
  return result.body;
}

const apply = ({ hash, version, files }: Preview) => api.post('/library/tv:1/torrent/apply', { hash, version, files });

function accepted(result: { status: number; body: unknown }) {
  expect(result.status, JSON.stringify(result.body)).toBeGreaterThanOrEqual(200);
  expect(result.status, JSON.stringify(result.body)).toBeLessThan(300);
}

function latch() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function seed(name: string, files: string[], progress: number) {
  const hash = hashOf(name, files);
  pipe.qbit.torrents.set(hash, {
    hash, name, size: files.length * 1000, progress, state: progress === 1 ? 'uploading' : 'downloading', category: 'personal', tags: '',
    save_path: pipe.folders.downloads, content_path: join(pipe.folders.downloads, name), dlspeed: 0, eta: 0, num_seeds: 1, num_leechs: 0, added_on: 1,
  });
  pipe.qbit.setFiles(hash, files.map((file) => ({ name: `${name}/${file}`, size: 1000, progress })));
  return hash;
}

beforeEach(async () => {
  pipe = await startPipeline({ handlers: (deps) => ({ 'queue.initial': queueInitialHandler(deps) }) });
  const tmdb = createTmdb({ apiKey: 'k', fetch: createTmdbFixture().fetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
  api = await pipe.api({ tmdb });
});

afterEach(async () => {
  api.close();
  await pipe.stop();
  rmSync(pipe.dir, { recursive: true, force: true });
  vi.restoreAllMocks();
});

describe('title torrent upload', () => {
  it('imports a movie without an indexer and sends the torrent only once', async () => {
    const name = 'Movie upload';
    const files = ['Feature.mkv', 'sample.mkv'];
    const hash = hashOf(name, files);
    const item = pipe.db.data.titles['movie:2'] = film();
    pipe.db.data.indexers = {};
    const bytes = makeTorrent(name, files);
    accepted(await upload(item.key, bytes));
    await until(() => pipe.qbit.torrents.has(hash));
    await upload(item.key, bytes);
    pipe.complete(name, { 'Feature.mkv': 'A'.repeat(1000), 'sample.mkv': 'S'.repeat(1000) }, hash);
    await until(() => pipe.queue.get(item.key)?.state.kind === 'available');
    expect(readFileSync(join(pipe.folders.movies, pipe.db.data.files[item.fileId!]!.path), 'utf8')).toBe('A'.repeat(1000));
    expect(adds()).toHaveLength(1);
    expect(pipe.db.data.torrents[hash]).toBeUndefined();
  });

  it.each([0.4, 1])('uses the existing torrent on its original client at progress %s', async (progress) => {
    const name = 'Owned by the user';
    const files = ['Feature.mkv'];
    const hash = seed(name, files, progress);
    const other = await startFakeQbit();
    pipe.db.data.downloadClients.unshift({ ...pipe.db.data.downloadClients[0]!, id: 'first', port: other.port });
    try {
      const item = pipe.db.data.titles['movie:2'] = film();
      if (progress === 1) pipe.complete(name, { 'Feature.mkv': 'A'.repeat(1000) }, hash);
      accepted(await upload(item.key, makeTorrent(name, files)));
      if (progress < 1) {
        await until(() => pipe.queue.get(item.key)?.state.kind === 'downloading');
        pipe.complete(name, { 'Feature.mkv': 'A'.repeat(1000) }, hash);
      }
      await until(() => pipe.queue.get(item.key)?.state.kind === 'available');
      expect(pipe.db.data.files[item.fileId!]!.download).toMatchObject({ hash, clientId: 'client-1', external: true });
      expect(pipe.db.data.sentTorrents[hash]).toBeUndefined();
      expect(other.calls.filter(({ path }) => path === 'torrents/add')).toEqual([]);
      expect(adds()).toEqual([]);
    } finally {
      other.close();
    }
  });

  it('accepts the same external torrent that Add already linked to the title', async () => {
    const item = pipe.db.data.titles['movie:2'] = film();
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    const paths = ['Feature.mkv'];
    const hash = seed(name, paths, 0.4);
    pipe.finder.requestSearch(item.key);
    await until(() => pipe.queue.get(item.key)?.state.kind === 'downloading');
    accepted(await upload(item.key, makeTorrent(name, paths)));
    pipe.complete(name, { 'Feature.mkv': 'A'.repeat(1000) }, hash);
    await until(() => pipe.queue.get(item.key)?.state.kind === 'available');
    expect(pipe.db.data.files[item.fileId!]!.download).toMatchObject({ hash, external: true });
    expect(adds()).toEqual([]);
  });

  it('previews the saved numbering by default and rejects assignments outside this manifest or catalog', async () => {
    const item = pipe.db.data.titles['tv:1'] = title({
      rootId: 'tv', episodes: [episode(1, 1), episode(1, 13)],
      numbering: { revision: 1, ranges: [{ season: 1, from: 13, to: 13, releaseSeason: 2, releaseFrom: 1 }] },
    });
    const view = await preview(makeTorrent('Pack', ['Season 02/Show.S02E01.mkv']));
    expect(view.files).toMatchObject([{ path: 'Pack/Season 02/Show.S02E01.mkv', episodes: [point(13)] }]);
    for (const changed of [
      { ...view, hash: 'b'.repeat(40) },
      { ...view, files: [{ path: 'Not in the torrent.mkv', episodes: [point(1)] }] },
      { ...view, files: [{ path: view.files[0]!.path, episodes: [point(999)] }] },
    ]) {
      expect([400, 409, 422]).toContain((await apply(changed)).status);
    }
    expect(pipe.db.data.queue).toEqual({});
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(item.numbering!.revision).toBe(1);
  });

  it('rejects a reviewed episode if a metadata refresh replaces it at the same season and number', async () => {
    const item = pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes: [episode(1, 1)] });
    const view = await preview(makeTorrent('Pack', ['Show.S01E01.mkv']));
    item.episodes = [episode(1, 1, null, { tmdbId: 222, name: 'A different episode' })];
    expect((await apply(view)).status).toBe(409);
    expect(pipe.db.data.queue).toEqual({});
    expect(adds()).toEqual([]);
  });

  it('maps the first sixteen Bleach folders numerically and leaves the seventeenth unresolved', async () => {
    const counts = [20, 21, 22, 28, 18, 22, 20, 16, 22, 16, 7, 17, 36, 51, 26, 24, 1];
    const numbers = Array.from({ length: 366 }, (_, i) => episode(1, i + 1, null, { tmdbId: 1000 + i }));
    pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes: [episode(0, 1), ...numbers, episode(2, 1)] });
    const files = counts.flatMap((count, i) => Array.from({ length: count }, (_, n) => `Season ${i + 1}/${n + 1}.mkv`)).reverse();
    const bytes = makeTorrent('Bleach', files);
    const view = await preview(bytes, 'folders');
    const assignments = new Map(view.files.map((file) => [file.path, file.episodes.map((ep) => point(ep.number, ep.season))]));
    let start = 0;
    for (const [at, count] of counts.entries()) {
      for (let n = 1; n <= count; n++) {
        expect(assignments.get(`Bleach/Season ${at + 1}/${n}.mkv`)).toEqual(at < 16 ? [point(start + n)] : []);
      }
      start += count;
    }
    expect(pipe.db.data.queue).toEqual({});
    expect(adds()).toEqual([]);
  });

  it('accepts a full-season review with long original paths', async () => {
    pipe.db.data.queuePaused = true;
    const episodes = Array.from({ length: 366 }, (_, i) => episode(1, i + 1));
    pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes });
    const root = `Series.${'edition.'.repeat(14)}complete`;
    const paths = episodes.map((e) => `Season 1/Series.${'release.'.repeat(16)}S01E${e.number}.mkv`);
    const bytes = makeTorrent(root, paths);
    const view = await preview(bytes);
    expect(Buffer.byteLength(JSON.stringify(view.files))).toBeGreaterThan(100 * 1024);
    accepted(await apply(view));
    expect(Object.keys(pipe.db.data.queue)).toHaveLength(episodes.length);
    expect(adds()).toEqual([]);
  });

  it('keeps a gap unresolved, counts global episode numbers once, and excludes extras', async () => {
    pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes: Array.from({ length: 7 }, (_, i) => episode(1, i + 1)) });
    const files = ['Season 1/1.mkv', 'Season 1/2.mkv', 'Extras/1.mkv', 'Season 2/3.mkv', 'Season 2/5.mkv', 'Season 3/1.mkv'];
    const view = await preview(makeTorrent('Show', files), 'folders');
    const filesOf = (n: number) => view.files.filter((f) => f.episodes.some((e) => e.number === n)).map((f) => f.path);
    expect(filesOf(3)).toEqual(['Show/Season 2/3.mkv']);
    expect(view.files.filter((f) => /\/(5|Extras\/1|Season 3\/1)\.mkv$/.test(f.path)).every((f) => !f.episodes.length)).toBe(true);
    expect(view.files.filter((f) => f.episodes.length)).toHaveLength(3);
  });

  it('recognizes the season in the root folder and continuous catalog numbers inside release folders', async () => {
    pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2)] });
    const root = await preview(makeTorrent('Season 1', ['1.mkv']), 'folders');
    expect(root.files).toMatchObject([{ path: 'Season 1/1.mkv', episodes: [point(1)] }]);
    const continuous = await preview(makeTorrent('Pack', ['Season 1/Show.S01E01.mkv', 'Season 2/Show.S01E02.mkv']), 'folders');
    expect(continuous.files.find((f) => f.path.includes('Season 2/'))?.episodes).toMatchObject([point(2)]);
  });

  it('imports only the accepted files and episodes, even when the torrent names disagree with TMDB', async () => {
    const name = 'Selected pack';
    const paths = ['Season 2/Show.S02E01.mkv', 'Season 2/Show.S02E02.mkv'];
    const item = pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes: [episode(1, 1), episode(1, 2), episode(1, 3)] });
    const bytes = makeTorrent(name, paths);
    const view = await preview(bytes);
    const selections = view.files.map(({ path }, i) => ({ path, episodes: i === 0 ? [point(2), point(3)] : [] }));
    accepted(await apply({ ...view, files: selections }));
    await until(() => pipe.queue.get('tv:1:1x2')?.state.kind === 'downloading');
    expect(pipe.queue.get('tv:1:1x1')).toBeUndefined();
    pipe.complete(name, { [paths[0]!]: 'Y'.repeat(1000), [paths[1]!]: 'N'.repeat(1000) }, view.hash);
    await until(() => item.episodes.slice(1).every((e) => pipe.queue.get(`tv:1:1x${e.number}`)?.state.kind === 'available'));
    await pipe.worker.drain();
    const file = pipe.db.data.files[item.episodes[1]!.fileId!]!;
    expect(item.episodes.map((e) => e.fileId)).toEqual([null, file.id, file.id]);
    expect(readFileSync(join(pipe.folders.tv, file.path), 'utf8')).toBe('Y'.repeat(1000));
    expect(file.episodes).toEqual([point(2), point(3)]);
    expect(adds()).toHaveLength(1);
    expect(pipe.queue.get('tv:1:1x1')).toBeUndefined();
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(Object.values(pipe.db.data.jobs).some((job) => job.type === 'queue.initial')).toBe(false);
  });

  it('keeps a library episode in the folder count without replacing its file', async () => {
    const episodes = [episode(1, 1), episode(1, 2), episode(1, 3)];
    const item = pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes });
    const saved = { id: 'kept', titleKey: item.key, path: 'Existing/E01.mkv', sizeBytes: 1000, mtimeMs: 1, episodes: [point(1)], missing: false, addedAt: 1 };
    pipe.db.data.files.kept = structuredClone(saved);
    mkdirSync(join(pipe.folders.tv, 'Existing'));
    writeFileSync(join(pipe.folders.tv, saved.path), 'L'.repeat(1000));
    episodes[0]!.fileId = saved.id;
    pipe.db.data.queuePaused = true;
    const view = await preview(makeTorrent('Series', ['Season 1/1.mkv', 'Season 1/2.mkv', 'Season 2/1.mkv']), 'folders');
    expect(view.files.find((f) => f.path.endsWith('/Season 2/1.mkv'))?.episodes).toMatchObject([point(3)]);
    accepted(await apply(view));
    expect(Object.keys(pipe.db.data.queue).sort()).toEqual(['tv:1:1x2', 'tv:1:1x3']);
    expect(item.episodes[0]?.fileId).toBe('kept');
    expect(pipe.db.data.files.kept).toEqual(saved);
  });

  it('honors an explicit correction when the client now reports a different file path', async () => {
    const item = pipe.db.data.titles['tv:1'] = title({ rootId: 'tv', episodes: [episode(1, 1)] });
    const pack = 'Original';
    const view = await preview(makeTorrent(pack, ['Show.S01E01.mkv']));
    accepted(await apply(view));
    const id = 'tv:1:1x1';
    await until(() => pipe.queue.get(id)?.state.kind === 'downloading');
    pipe.complete(pack, { 'Renamed.mkv': 'R'.repeat(1000) }, view.hash);
    await until(() => pipe.queue.get(id)?.state.kind === 'blocked');
    const match = { file: 'Renamed.mkv', covers: [point(1)], ids: [id], source: 'download' };
    const path = `/queue/entries/${id}/match`;
    const first = await api.post(path, { ...match, preview: true });
    accepted(first);
    accepted(await api.post(path, { ...match, version: first.body.version }));
    await until(() => pipe.queue.get(id)?.state.kind === 'available');
    expect(readFileSync(join(pipe.folders.tv, pipe.db.data.files[item.episodes[0]!.fileId!]!.path), 'utf8')).toBe('R'.repeat(1000));
    expect(pipe.tracker.state.searches).toEqual([]);
  });

  it.each([true, false])('starts a fresh search after an unsent upload, cached bytes: %s', async (cached) => {
    const item = pipe.db.data.titles['movie:2'] = film();
    pipe.db.data.queuePaused = true;
    const bytes = makeTorrent('For retry', ['Movie.mkv'], 'Retain this metadata.');
    const hash = hashOf('For retry', ['Movie.mkv']);
    accepted(await upload(item.key, bytes));
    const entry = pipe.queue.get(item.key)!;
    expect(entry.state.kind).toBe('waiting_slot');
    if (!cached) delete pipe.db.data.torrents[hash];
    pipe.queue.block(entry, { code: 'client_unreachable' }, 'client unavailable before send');
    accepted(await api.post('/queue/actions', { action: 'retry', ids: [entry.id] }));
    expect(entry.release).toBeNull();
    expect(pipe.db.data.torrents[hash]).toBeUndefined();
    accepted(await api.post('/queue/actions', { action: 'priority', ids: [entry.id] }));
    pipe.queue.setPaused(false);
    await until(() => entry.state.kind === 'waiting');
    expect(pipe.tracker.state.searches.length).toBeGreaterThan(0);
    expect(adds()).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
  });

  it('does not claim an unsent upload for removal when a user adds it to qBittorrent during the wait', async () => {
    pipe.db.data.queuePaused = true;
    const item = pipe.db.data.titles['movie:2'] = film();
    const paths = ['Feature.mkv'];
    accepted(await upload(item.key, makeTorrent('Waiting', paths)));
    seed('Waiting', paths, 0.4);
    const entry = pipe.queue.get(item.key)!;
    expect(entry.state.kind).toBe('waiting_slot');
    expect(torrentsForRemoval([entry], [])).toEqual([]);
    expect(adds()).toEqual([]);
  });

  it('rejects an invalid file, oversize upload, and ambiguous movie before any queue change', async () => {
    pipe.db.data.titles['movie:2'] = film();
    for (const bytes of [Buffer.from('invalid'), Buffer.alloc(5 * MIB + 1), makeTorrent('Two films', ['One.mkv', 'Two.mkv'])]) {
      expect([400, 409, 413, 415, 422]).toContain((await upload('movie:2', bytes)).status);
    }
    expect(pipe.db.data.queue).toEqual({});
    expect(pipe.db.data.files).toEqual({});
    expect(adds()).toEqual([]);
  });

  it('protects an active transfer against another torrent or a claim from another title', async () => {
    const first = pipe.db.data.titles['movie:2'] = film();
    const second = pipe.db.data.titles['movie:3'] = movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie' });
    const bytes = makeTorrent('First', ['First.mkv']);
    accepted(await upload(first.key, bytes));
    await until(() => pipe.queue.get(first.key)?.state.kind === 'downloading');
    expect((await upload(second.key, bytes)).status).toBe(409);
    expect((await upload(first.key, makeTorrent('Other', ['Other.mkv']))).status).toBe(409);
    expect(pipe.queue.get(first.key)?.transferHash).toBe(hashOf('First', ['First.mkv']));
    expect(pipe.queue.get(second.key)).toBeUndefined();
    expect(adds()).toHaveLength(1);
  });

  it('discards an old indexer result when the user selects a torrent during search', async () => {
    const item = pipe.db.data.titles['movie:2'] = film();
    pipe.tracker.state.items = [{ title: 'Movie.Name.2019.1080p.BluRay-GRP', size: 12000 * MIB }];
    const waiting = latch();
    const release = latch();
    const search = pipe.indexers.search.bind(pipe.indexers);
    vi.spyOn(pipe.indexers, 'search').mockImplementation(async (...args) => {
      const answer = await search(...args);
      waiting.resolve();
      const signal = args[2]?.signal;
      if (!signal?.aborted) {
        signal?.addEventListener('abort', () => release.resolve(), { once: true });
        await release.promise;
      }
      return answer;
    });
    pipe.finder.requestSearch(item.key);
    try {
      await waiting.promise;
      accepted(await upload(item.key, makeTorrent('Chosen', ['Feature.mkv'])));
    } finally {
      release.resolve();
    }
    await until(() => pipe.queue.get(item.key)?.state.kind === 'downloading');
    await pipe.worker.drain();
    expect([...pipe.qbit.torrents.keys()]).toEqual([hashOf('Chosen', ['Feature.mkv'])]);
    expect(pipe.tracker.state.downloads).toEqual([]);
  }, 12_000);

  it('does not block the upload when an earlier fetch reports its final client error', async () => {
    const item = pipe.db.data.titles['movie:2'] = film();
    pipe.db.data.queuePaused = true;
    const entry = pipe.queue.ensure(item.key, null, null);
    pipe.queue.request(entry, 'indexer release');
    const name = 'Movie.Name.2019.1080p.BluRay-GRP';
    const hash = hashOf(name);
    const started = latch();
    const finish = latch();
    const clients = createClients();
    const client = clients.get('client-1')!.api;
    vi.spyOn(client, 'metadataFiles').mockImplementation(async () => {
      started.resolve();
      await finish.promise;
      throw new ClientError('unreachable', 'The old request did not complete.');
    });
    const finder = createFinder({ ...pipe, clients, enqueue: pipe.worker.enqueue });
    const job = finder.enqueueSearch({
      titleKey: item.key, season: null, entryIds: [entry.id], manual: true, forced: true,
      supplied: [{
        guid: name, indexerId: 1, title: name, infoHash: hash, sizeBytes: 100 * 120 * MIB, link: null,
        magnet: `magnet:?xt=urn:btih:${hash}`, seeders: 20, publishedAt: null, peers: null, categories: [],
      }],
    });
    const handler = queueSearchHandler(finder);
    job.attempts = handler.maxAttempts!;
    const old = Promise.resolve(handler.run(job, { signal: new AbortController().signal })).catch(() => {});
    try {
      await started.promise;
      accepted(await upload(item.key, makeTorrent('Selected', ['Movie.mkv'])));
    } finally {
      finish.resolve();
      await old;
    }
    expect(entry.state.kind).not.toBe('blocked');
    pipe.queue.setPaused(false);
    await until(() => entry.state.kind === 'downloading');
    expect([...pipe.qbit.torrents.keys()]).toEqual([hashOf('Selected', ['Movie.mkv'])]);
    expect(pipe.tracker.state.downloads).toEqual([]);
  });
});

describe('downloads from a title page', () => {
  beforeEach(() => {
    pipe.db.data.settings.defaultRoots = { movie: 'movie', tv: 'tv' };
  });

  it('adds a catalog movie paused only after a valid torrent upload', async () => {
    const key = `movie:${MOVIE_ID}`;
    const name = 'Movie upload';
    const files = ['Feature.mkv'];
    const hash = hashOf(name, files);
    expect((await upload(key, makeTorrent(name, ['One.mkv', 'Two.mkv']))).status).toBe(422);
    expect(pipe.db.data.titles[key]).toBeUndefined();
    expect(pipe.db.data.queue).toEqual({});
    expect(adds()).toEqual([]);

    accepted(await upload(key, makeTorrent(name, files)));
    expect(pipe.db.data.titles[key]).toMatchObject({ paused: true, rootId: 'movie' });
    expect(Object.keys(pipe.db.data.queue)).toEqual([key]);
    expect(pipe.queue.get(key)).toMatchObject({ transferHash: hash, release: { uploadPath: `${name}/Feature.mkv` } });
    await until(() => pipe.qbit.torrents.has(hash));
    expect(pipe.tracker.state.searches).toEqual([]);
  });

  it.each([
    { context: 'a library movie', key: 'movie:2', stored: true, file: 'Feature.mkv', suffix: '' },
    { context: 'a catalog movie', key: `movie:${MOVIE_ID}`, stored: false, file: 'Feature.mkv', suffix: '' },
    { context: 'a catalog series', key: `tv:${SERIES_ID}`, stored: false, file: 'Breaking.Bad.S01E01.mkv', suffix: ':1x1' },
  ])('lists and attaches a completed download for $context', async ({ key, stored, file, suffix }) => {
    if (stored) pipe.db.data.titles[key] = film();
    const name = 'Completed download';
    const hash = seed(name, [file], 1);
    pipe.complete(name, { [file]: 'video' }, hash);
    const invalid = seed('Notes', ['notes.txt'], 1);
    const path = `/library/${key}/attach`;

    const listing = await api.get(path);
    expect(listing.status).toBe(200);
    expect(listing.body.torrents).toContainEqual(expect.objectContaining({ hash, complete: true }));
    expect(Object.keys(pipe.db.data.titles)).toEqual(stored ? [key] : []);
    expect(pipe.db.data.queue).toEqual({});

    expect((await api.post(path, { hash: invalid })).status).toBe(409);
    expect(Object.keys(pipe.db.data.titles)).toEqual(stored ? [key] : []);
    expect(pipe.db.data.queue).toEqual({});

    expect((await api.post(path, { hash })).status).toBe(200);
    expect(pipe.db.data.titles[key]).toMatchObject({ paused: !stored, rootId: suffix ? 'tv' : 'movie' });
    expect(Object.keys(pipe.db.data.queue)).toEqual([`${key}${suffix}`]);
    expect(pipe.queue.get(`${key}${suffix}`)).toMatchObject({ transferHash: hash, release: { external: true } });
    expect(adds()).toEqual([]);
    expect(pipe.tracker.state.searches).toEqual([]);
  });
});
