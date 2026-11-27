import { move, branchOf } from '../helpers/test-queue.ts';
import { stageOf, reasonOfEntry } from '../../src/library/downloads/queue.ts';
import { createRetry } from '../../src/library/downloads/queue-api.ts';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import { withTitleLock } from '../../src/core/title-lock.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';

// A retry moves the target at once, so the page shows the new work before the job that resolves it starts.
describe('retry at once', () => {
  it('moves a stopped target out of its problem before the job runs', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const entry = pipe.queue.ensure(film.key, null, null);
    pipe.queue.request(entry, 'test');
    move(pipe.queue, entry, { stage: 'searching', reason: { code: 'too_many_attempts' } }, 'test');
    expect(entry.state.kind).toBe('blocked');

    const jobs: { type: string; payload: unknown }[] = [];
    const { retry } = createRetry({ queue: pipe.queue, enqueue: (input) => (jobs.push(input as never), {} as never) });
    retry(entry);

    // The target leaves the problem now, not when the worker picks the job.
    expect(entry.state.kind).toBe('queued');
    expect(reasonOfEntry(entry)).toBeNull();
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ type: 'queue.retry', payload: { entryIds: [film.key] } });
  });

  it('moves a target that waits for its next search', async () => {
    pipe = await startPipeline();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    const entry = pipe.queue.ensure(film.key, null, null);
    pipe.queue.request(entry, 'test');
    move(pipe.queue, entry, { stage: 'searching', branch: 'waiting', reason: { code: 'no_results' } }, 'test');
    expect(entry.state.kind).toBe('waiting');

    const { retry } = createRetry({ queue: pipe.queue, enqueue: () => ({}) as never });
    retry(entry);

    expect(entry.state.kind).toBe('queued');
  });

  it('checks the local file only when the retry gets its search turn', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    // A search holds the first turn until its title lock is free.
    const release: (() => void)[] = [];
    try {
      for (const [index, key] of ['tv:2', 'tv:3'].entries()) {
        const series = title({ key, tmdbId: index + 2, rootId: 'tv', folder: `Other Show ${index + 2}`, episodes: [episode(1, 1)] });
        pipe.db.data.titles[key] = series;
        const entry = pipe.queue.ensure(key, 1, 1);
        pipe.queue.request(entry, 'test');
        move(pipe.queue, entry, { stage: 'searching', reason: { code: 'too_many_attempts' } }, 'test');
        void withTitleLock(key, () => new Promise<void>((resolve) => release.push(resolve)));
        expect((await api.post('/queue/actions', { action: 'retry', ids: [entry.id] })).status).toBe(200);
      }
      await until(() => Object.values(pipe!.db.data.jobs).some((job) => job.type === 'queue.search' && job.state === 'running'));

      const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1)] });
      pipe.db.data.titles[series.key] = series;
      const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
      mkdirSync(folder, { recursive: true });
      writeFileSync(join(folder, 'Show Name - S01E01.mkv'), 'episode-one');
      const entry = pipe.queue.ensure('tv:1', 1, 1);
      pipe.queue.request(entry, 'test');
      move(pipe.queue, entry, { stage: 'searching', reason: { code: 'too_many_attempts' } }, 'test');

      expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);
      expect(entry.state.kind).toBe('queued');
      expect(series.episodes[0]!.fileId).toBeNull();
      release.forEach((resolve) => resolve());
      await until(() => stageOf(entry) === 'available', 5_000);
      expect(entry.history.map((event) => event.stage)).toContain('searching');
    } finally {
      // The locks of the test must not outlive it, because the next one reads the same titles.
      for (const resolve of release) resolve();
    }
  });
});


// The retry walks the phases of a target in order, and stops at the first one that resolves it: the library folder,
// the download client, the release, and the search.
describe('retry', () => {
  it('takes the file that is in the library folder', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    // The file name has no SxxExx, and the folder names the season. This is the shape of the reported case.
    const folder = join(pipe.folders.tv, 'Show Name (2020)', 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Show Name E01.mkv'), 'video-data');

    const entry = pipe.queue.ensure('tv:1', 1, 1);
    pipe.queue.request(entry, 'test');
    move(pipe.queue, entry, { stage: 'queued', branch: null, reason: { code: 'too_many_attempts' } }, 'test');
    const history = entry.history.length;

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);

    // The folder is read from the disk, so the target ends with no search and no client request.
    await until(() => stageOf(entry) === 'available');
    expect(reasonOfEntry(entry)).toBeNull();
    const files = Object.values(pipe.db.data.files);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('Show Name (2020)/Season 01/Show Name E01.mkv');
    expect(files[0]!.episodes).toEqual([{ season: 1, number: 1 }]);
    expect(files[0]!.titleKey).toBe(series.key);
    expect(files[0]!.sizeBytes).toBe(Buffer.byteLength('video-data'));
    expect(series.episodes[0]!.fileId).toBe(files[0]!.id);
    const stages = entry.history.slice(history).map((event) => event.stage);
    expect(stages.indexOf('importing')).toBeGreaterThanOrEqual(0);
    expect(stages.indexOf('importing')).toBeLessThan(stages.indexOf('available'));
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it.each(['movie', 'tv'] as const)('keeps an empty library file blocked at import for %s', async (mediaType) => {
    pipe = await startPipeline();
    api = await pipe.api();
    const item = mediaType === 'movie'
      ? movie({ rootId: 'movie', folder: 'Movie Name (2019)', manualRelease: true })
      : title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1)] });
    pipe.db.data.titles[item.key] = item;
    const folder = mediaType === 'movie'
      ? join(pipe.folders.movies, item.folder!)
      : join(pipe.folders.tv, item.folder!, 'Season 01');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, mediaType === 'movie' ? 'Movie Name (2019).mkv' : 'Show Name - S01E01.mkv'), '');
    const entry = pipe.queue.ensure(item.key, mediaType === 'movie' ? null : 1, mediaType === 'movie' ? null : 1);
    pipe.queue.request(entry, 'test');
    move(pipe.queue, entry, { stage: 'searching', reason: { code: 'too_many_attempts' } }, 'test');
    const history = entry.history.length;

    expect((await api.post('/queue/actions', { action: 'retry', ids: [entry.id] })).status).toBe(200);
    await until(() => entry.state.kind === 'blocked' && entry.state.at === 'importing');

    expect(entry.state).toMatchObject({ kind: 'blocked', at: 'importing', problem: { code: 'file_invalid' } });
    expect(entry.history.slice(history).some((event) => event.stage === 'importing')).toBe(true);
    expect(entry.history.slice(history).some((event) => event.state.kind === 'available')).toBe(false);
    expect(entry.completedAt).toBeNull();
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it.each(['movie', 'tv'] as const)('does not complete %s from a file pointer that belongs to another title', async (mediaType) => {
    pipe = await startPipeline();
    api = await pipe.api();
    const item = mediaType === 'movie'
      ? movie({ rootId: 'movie', folder: 'Movie Name (2019)', manualRelease: true })
      : title({ rootId: 'tv', folder: 'Show Name (2020)', episodes: [episode(1, 1)] });
    pipe.db.data.titles[item.key] = item;
    const root = mediaType === 'movie' ? pipe.folders.movies : pipe.folders.tv;
    mkdirSync(join(root, item.folder!), { recursive: true });
    mkdirSync(join(root, 'Other Title'), { recursive: true });
    writeFileSync(join(root, 'Other Title', 'Other Title.mkv'), 'other-content');
    const file = {
      id: 'other-file', titleKey: `${mediaType}:99`, path: 'Other Title/Other Title.mkv',
      sizeBytes: Buffer.byteLength('other-content'), mtimeMs: 0, episodes: mediaType === 'movie' ? [] : [{ season: 1, number: 1 }],
      missing: false, addedAt: Date.now(),
    };
    pipe.db.data.files[file.id] = file;
    if (mediaType === 'movie') item.fileId = file.id;
    else item.episodes[0]!.fileId = file.id;
    const entry = pipe.queue.ensure(item.key, mediaType === 'movie' ? null : 1, mediaType === 'movie' ? null : 1);
    pipe.queue.request(entry, 'test');
    move(pipe.queue, entry, { stage: 'searching', reason: { code: 'too_many_attempts' } }, 'test');
    const history = entry.history.length;

    expect((await api.post('/queue/actions', { action: 'retry', ids: [entry.id] })).status).toBe(200);
    await until(() => entry.state.kind === 'blocked');

    expect(entry.state.kind).not.toBe('available');
    expect(entry.history.slice(history).some((event) => event.state.kind === 'available')).toBe(false);
    expect(entry.completedAt).toBeNull();
    expect(pipe.db.data.files[file.id]).toEqual(file);
    expect(pipe.tracker.state.downloads).toEqual([]);
  });

  it('resumes the import of a torrent that the client has', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    await until(() => stageOf(pipe!.queue.get('movie:2')!) === 'downloading');
    const entry = pipe.queue.get('movie:2')!;

    // The file of the import is in the library already, so the import stops instead of replacing it.
    const folder = join(pipe.folders.movies, 'Movie Name (2019)');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Movie Name (2019).mkv'), 'someone else');
    pipe.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });
    await until(() => reasonOfEntry(entry)?.code === 'destination_exists');

    rmSync(join(folder, 'Movie Name (2019).mkv'));
    const downloads = pipe.tracker.state.downloads.length;
    expect(downloads).toBe(1);

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['movie:2'] })).status).toBe(200);

    // The client has the finished torrent, so the target validates and imports it again.
    await until(() => stageOf(entry) === 'available');
    expect(reasonOfEntry(entry)).toBeNull();
    expect(entry.release).not.toBeNull();
    expect(pipe.tracker.state.downloads.length).toBe(downloads);
    expect(Object.values(pipe.db.data.files).some((file) => file.path === 'Movie Name (2019)/Movie Name (2019).mkv')).toBe(true);
  });

  it('keeps a torrent that still downloads and does not search again', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    const release = 'Show.Name.S01E01.1080p.WEB-DL-GRP';
    pipe.tracker.state.items = [{ title: release, size: 60 * 45 * MIB }];
    pipe.finder.requestSearch('tv:1');
    const entry = pipe.queue.get('tv:1:1x1')!;
    await until(() => stageOf(entry) === 'downloading');

    const hash = hashOf(release);
    pipe.qbit.progress(hash, 0.5);
    await until(() => pipe!.poller.transfer(hash)?.progress === 0.5);
    move(pipe.queue, entry, { stage: 'downloading', reason: { code: 'client_error' } }, 'test');

    const searches = pipe.tracker.state.searches.length;
    const downloads = pipe.tracker.state.downloads.length;

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);

    // The torrent is in the client and it has not finished, so the target downloads it again with no new search.
    await until(() => stageOf(entry) === 'downloading');
    expect(pipe.tracker.state.searches.length).toBe(searches);
    expect(pipe.tracker.state.downloads.length).toBe(downloads);
  });

  it('searches only when the earlier phases have nothing', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const series = title({ rootId: 'tv', episodes: [episode(1, 1, '2020-01-01')] });
    pipe.db.data.titles[series.key] = series;
    const entry = pipe.queue.ensure('tv:1', 1, 1);
    pipe.queue.request(entry, 'test');
    move(pipe.queue, entry, { stage: 'queued', branch: null, reason: { code: 'too_many_attempts' } }, 'test');

    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);

    // No file, no torrent and no release: the target searches, finds the release, and downloads it.
    await until(() => stageOf(entry) === 'downloading');
    expect(pipe.tracker.state.searches.length).toBeGreaterThan(0);
    expect(pipe.tracker.state.downloads.length).toBe(1);
  });
});
