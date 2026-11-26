import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { stageOf } from '../../src/library/downloads/queue.ts';
import { movie } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';
const SECOND = 'Other.Movie.2019.1080p.BluRay-GRP';
const items = [
  { title: NAME, size: 100 * 120 * MIB },
  { title: SECOND, size: 100 * 120 * MIB },
];

// A movie with a manual release, so a search is possible whatever its release date.
const film = () => movie({ rootId: 'movie', manualRelease: true });
const other = () => movie({ key: 'movie:3', tmdbId: 3, rootId: 'movie', manualRelease: true, meta: { ...movie().meta, tmdbId: 3, title: 'Other Movie', originalTitle: 'Other Movie' } });

function twoMovies() {
  const first = film();
  const next = other();
  pipe!.db.data.titles[first.key] = first;
  pipe!.db.data.titles[next.key] = next;
  pipe!.tracker.state.items = items;
  return { first, next };
}

// A torrent that the client has already, as if the user added it or an earlier run left it.
function addClientTorrent(name: string, progress: number) {
  const hash = hashOf(name);
  pipe!.qbit.torrents.set(hash, {
    hash,
    name,
    size: 1_000_000,
    progress,
    state: progress >= 1 ? 'uploading' : 'downloading',
    category: 'ladarr',
    tags: '',
    save_path: pipe!.folders.downloads,
    content_path: join(pipe!.folders.downloads, name),
    dlspeed: progress >= 1 ? 0 : 1_000,
    eta: progress >= 1 ? 0 : 100,
    num_seeds: 1,
    num_leechs: 1,
    added_on: Math.floor(Date.now() / 1000),
  });
  return hash;
}

describe('search preflight', () => {
  it('completes a movie whose file is in its title folder with no search and no torrent', async () => {
    pipe = await startPipeline();
    const title = film();
    pipe.db.data.titles[title.key] = title;
    const folder = join(pipe.folders.movies, 'Movie Name (2019)');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Movie Name (2019).mkv'), 'the-film');

    pipe.finder.requestSearch(title.key);
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'available');

    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(0);
    expect(Object.values(pipe.db.data.files)).toHaveLength(1);
  });

  it('attaches a matching torrent that the client has, with no search and no second torrent', async () => {
    pipe = await startPipeline();
    const title = film();
    pipe.db.data.titles[title.key] = title;
    // The user added this torrent by hand, and it still downloads.
    const hash = addClientTorrent(NAME, 0.4);

    pipe.finder.requestSearch(title.key);
    const entry = pipe.queue.get('movie:2')!;
    await until(() => stageOf(entry) === 'downloading');

    expect(entry.transferHash).toBe(hash);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(1);

    pipe.complete(NAME, { 'Movie.mkv': 'the-film' });
    await until(() => stageOf(entry) === 'available');
    expect(pipe.qbit.torrents.size).toBe(1);
  });

  it('attaches a matching complete torrent and imports it, with no search', async () => {
    pipe = await startPipeline();
    const title = film();
    pipe.db.data.titles[title.key] = title;
    // The client finished this torrent before ladarr found the release.
    const hash = addClientTorrent(NAME, 1);
    pipe.complete(NAME, { 'Movie.mkv': 'the-film' });

    pipe.finder.requestSearch(title.key);
    const entry = pipe.queue.get('movie:2')!;
    await until(() => entry.history.some((event) => event.stage === 'importing'));
    await until(() => stageOf(entry) === 'available');

    expect(entry.transferHash).toBe(hash);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(Object.values(pipe.db.data.files)).toHaveLength(1);
  });

  it('does not search while the client does not answer, and downloads the release once on a retry', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const title = film();
    pipe.db.data.titles[title.key] = title;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    // The client destroys its sockets, so ladarr can not read the torrents that it has.
    pipe.qbit.control.down = true;

    pipe.finder.requestSearch(title.key);
    const entry = pipe.queue.get('movie:2')!;
    await until(() => entry.state.kind === 'blocked' && entry.state.problem.code === 'client_unreachable');

    // A client that does not answer is not a client without the download.
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);

    pipe.qbit.control.down = false;
    expect((await api.post('/queue/actions', { action: 'retry', ids: [entry.id] })).status).toBe(200);
    await until(() => stageOf(entry) === 'downloading');

    expect(pipe.tracker.state.downloads).toEqual([NAME]);
  }, 15_000);
});

describe('a full client', () => {
  it('fetches both releases, and sends the waiting one when a slot frees', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    Object.assign(pipe.db.data.downloadClients[0]!, { maxDownloads: 1 });
    const { first, next } = twoMovies();

    pipe.finder.requestSearch(first.key);
    await until(() => pipe!.qbit.torrents.has(hashOf(NAME)));
    pipe.finder.requestSearch(next.key);
    await until(() => pipe!.tracker.state.downloads.includes(SECOND));
    await pipe.worker.drain();

    expect.soft((await api.get(`/queue/entries/${next.key}`)).body.entry).toMatchObject({ status: 'fetching', release: { title: SECOND } });
    expect(pipe.qbit.torrents.size).toBe(1);

    pipe.complete(NAME, { [`${NAME}.mkv`]: 'the-film' });
    pipe.worker.resume();
    await until(() => pipe!.qbit.torrents.has(hashOf(SECOND)));
    expect(pipe.tracker.state.downloads).toEqual([NAME, SECOND]);
    expect(pipe.qbit.calls.filter(({ path }) => path === 'torrents/add')).toHaveLength(2);
  }, 15_000);
});

// A movie whose download is complete, but whose import fails every time.
async function unreadableMovie() {
  pipe = await startPipeline({ probe: async () => ({ ok: false, reason: 'unreadable' }) });
  api = await pipe.api();
  const title = film();
  pipe.db.data.titles[title.key] = title;
  pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
  pipe.finder.requestSearch(title.key);
  const entry = pipe.queue.get('movie:2')!;
  await until(() => stageOf(entry) === 'downloading');
  pipe.complete(NAME, { [`${NAME}.mkv`]: 'the-film' });
  await until(() => entry.state.kind === 'blocked' && entry.state.at === 'importing' && entry.state.problem.code === 'file_unreadable');
  return entry;
}

describe('failed imports', () => {
  it('does not retry automatically after the import blocks', async () => {
    const entry = await unreadableMovie();
    await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run'));
    const before = structuredClone(entry);
    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing', problem: { code: 'file_unreadable' } });

    const job = pipe!.worker.enqueue({ type: 'import.run', payload: { hash: entry.transferHash! }, dedupeKey: `import:${entry.transferHash}` });
    await until(() => !pipe!.db.data.jobs[job.id]);

    expect(entry).toEqual(before);
  }, 20_000);

  it('reruns the import checks on a manual retry, with no limit and no new download', async () => {
    const entry = await unreadableMovie();
    await until(() => !Object.values(pipe!.db.data.jobs).some((job) => job.type === 'import.run'));
    const tries = entry.importTries;
    const downloads = pipe!.tracker.state.downloads.length;
    const blocks = entry.history.filter((event) => event.cause === 'import blocked').length;

    expect((await api!.post('/queue/actions', { action: 'retry', ids: [entry.id] })).status).toBe(200);

    // The retry lifts the block at once, and the import checks run again.
    expect(entry.history.some((event) => event.cause === 'retry: the import checks run again')).toBe(true);
    await until(() => entry.history.filter((event) => event.cause === 'import blocked').length > blocks);

    // The manual run does not use the automatic budget, and it does not fetch the release again.
    expect(entry.importTries).toBe(tries);
    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing', problem: { code: 'file_unreadable' } });
    expect(pipe!.tracker.state.downloads.length).toBe(downloads);
  }, 20_000);
});
