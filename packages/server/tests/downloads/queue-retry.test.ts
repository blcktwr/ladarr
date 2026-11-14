import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { episode, movie, title } from '../helpers/test-fixtures.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

let pipe: Awaited<ReturnType<typeof startPipeline>> | undefined;
let api: Awaited<ReturnType<Awaited<ReturnType<typeof startPipeline>>['api']>> | undefined;
afterEach(async () => {
  api?.close();
  await pipe?.stop();
  pipe = api = undefined;
});

const NAME = 'Movie.Name.2019.1080p.BluRay-GRP';

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
    pipe.queue.move(entry, { stage: 'queued', branch: null, reason: { code: 'too_many_attempts' } }, 'test');

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);

    // The folder is read from the disk, so the target ends with no search and no client request.
    await until(() => entry.stage === 'available');
    expect(entry.reason).toBeNull();
    const files = Object.values(pipe.db.data.files);
    expect(files).toHaveLength(1);
    expect(files[0]!.path).toBe('Show Name (2020)/Season 01/Show Name E01.mkv');
    expect(files[0]!.episodes).toEqual([{ season: 1, number: 1 }]);
    expect(pipe.tracker.state.searches).toEqual([]);
    expect(pipe.tracker.state.downloads).toEqual([]);
    expect(pipe.qbit.torrents.size).toBe(0);
  });

  it('resumes the import of a torrent that the client has', async () => {
    pipe = await startPipeline();
    api = await pipe.api();
    const film = movie({ rootId: 'movie', manualRelease: true });
    pipe.db.data.titles[film.key] = film;
    pipe.tracker.state.items = [{ title: NAME, size: 100 * 120 * MIB }];
    await api.post('/queue/search', { titleKey: film.key });
    await until(() => pipe!.queue.get('movie:2')!.stage === 'downloading');
    const entry = pipe.queue.get('movie:2')!;

    // The file of the import is in the library already, so the import stops instead of replacing it.
    const folder = join(pipe.folders.movies, 'Movie Name (2019)');
    mkdirSync(folder, { recursive: true });
    writeFileSync(join(folder, 'Movie Name (2019).mkv'), 'someone else');
    pipe.complete(NAME, { [`${NAME}.mkv`]: 'video-data' });
    await until(() => entry.reason?.code === 'destination_exists');

    rmSync(join(folder, 'Movie Name (2019).mkv'));
    const downloads = pipe.tracker.state.downloads.length;
    expect(downloads).toBe(1);

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['movie:2'] })).status).toBe(200);

    // The client has the finished torrent, so the target validates and imports it again.
    await until(() => entry.stage === 'available');
    expect(entry.reason).toBeNull();
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
    await until(() => entry.stage === 'downloading');

    const hash = hashOf(release);
    pipe.qbit.progress(hash, 0.5);
    await until(() => pipe!.poller.transfer(hash)?.progress === 0.5);
    pipe.queue.move(entry, { stage: 'downloading', reason: { code: 'client_error' } }, 'test');

    const searches = pipe.tracker.state.searches.length;
    const downloads = pipe.tracker.state.downloads.length;

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);

    // The torrent is in the client and it has not finished, so the target downloads it again with no new search.
    await until(() => entry.reason === null);
    expect(entry.stage).toBe('downloading');
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
    pipe.queue.move(entry, { stage: 'queued', branch: null, reason: { code: 'too_many_attempts' } }, 'test');

    pipe.tracker.state.items = [{ title: 'Show.Name.S01E01.1080p.WEB-DL-GRP', size: 60 * 45 * MIB }];

    expect((await api.post('/queue/actions', { action: 'retry', ids: ['tv:1:1x1'] })).status).toBe(200);

    // No file, no torrent and no release: the target searches, finds the release, and downloads it.
    await until(() => entry.stage === 'downloading');
    expect(pipe.tracker.state.searches.length).toBeGreaterThan(0);
    expect(pipe.tracker.state.downloads.length).toBe(1);
  });
});
