import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createApp } from '../../src/app.ts';
import { open } from '../../src/core/db.ts';
import { metadataRefreshHandler } from '../../src/jobs/metadata-refresh.ts';
import { queueInitialHandler } from '../../src/jobs/queue-initial.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';
import { timespan } from '../../src/proxy/common.ts';
import { FakeRadarr, FakeSonarr, type AddSeriesOptions, type RadarrMovieOptions } from '../helpers/test-seerr.ts';
import { hashOf, MIB, startPipeline, until } from '../helpers/test-pipeline.ts';

// The fake Seerr replays the requests of Seerr 3.5.1 against ladarr. A running Seerr has not been tested.

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const MOVIE = {
  id: 603,
  title: 'Movie Name',
  original_title: 'Movie Name',
  original_language: 'en',
  overview: 'A movie.',
  release_date: '2019-03-01',
  runtime: 100,
  status: 'Released',
  imdb_id: 'tt0133093',
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2019-06-01T00:00:00.000Z' }] }] },
  alternative_titles: { titles: [] },
};

const SHOW = {
  id: 1396,
  name: 'Show Name',
  original_name: 'Show Name',
  original_language: 'en',
  overview: 'A show.',
  first_air_date: '2020-01-01',
  status: 'Returning Series',
  episode_run_time: [45],
  external_ids: { tvdb_id: 81189, imdb_id: 'tt0903747' },
  alternative_titles: { results: [] },
  seasons: [
    { season_number: 0, episode_count: 1, air_date: '2019-12-01' },
    { season_number: 1, episode_count: 2, air_date: '2020-01-01' },
    { season_number: 2, episode_count: 1, air_date: '2021-01-01' },
  ],
};

// The IDs of the episodes are TMDB IDs. TVDB IDs are not in these answers.
const SEASONS: Record<number, { id: number; episode_number: number; name: string; air_date: string; runtime: number }[]> = {
  0: [{ id: 9001, episode_number: 1, name: 'Special', air_date: '2019-12-01', runtime: 20 }],
  1: [
    { id: 9101, episode_number: 1, name: 'One', air_date: '2020-01-01', runtime: 45 },
    { id: 9102, episode_number: 2, name: 'Two', air_date: '2020-01-08', runtime: 45 },
  ],
  2: [{ id: 9201, episode_number: 1, name: 'Three', air_date: '2021-01-01', runtime: 45 }],
};

const tmdbFetch = (async (input: URL | string) => {
  const path = new URL(String(input)).pathname.replace(/^\/3/, '');
  if (path === '/movie/603') return json(MOVIE);
  if (path === '/movie/500') return json({}, 503);
  if (path === '/tv/1396') return json(SHOW);
  const season = /^\/tv\/1396\/season\/(\d+)$/.exec(path);
  if (season && SEASONS[Number(season[1])]) return json({ episodes: SEASONS[Number(season[1])] });
  if (path === '/find/81189') return json({ tv_results: [{ id: 1396, name: 'Show Name', first_air_date: '2020-01-01' }] });
  // Two TMDB series with the same TVDB ID: ladarr must not pick one.
  if (path === '/find/5555') return json({ tv_results: [{ id: 1396, name: 'Show Name' }, { id: 1397, name: 'Other Show' }] });
  if (path.startsWith('/find/')) return json({ tv_results: [] });
  return json({}, 404);
}) as typeof fetch;

let rig: Awaited<ReturnType<typeof start>> | undefined;
afterEach(async () => {
  rig?.app.close();
  await rig?.pipe.stop();
  rig = undefined;
});

async function start(options: Parameters<typeof startPipeline>[0] = {}) {
  const tmdb = createTmdb({ apiKey: 'k', fetch: tmdbFetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
  const pipe = await startPipeline({ ...options, handlers: ({ db, events, queue, finder }) => ({ 'metadata.refresh': metadataRefreshHandler({ db, tmdb, events }), 'queue.initial': queueInitialHandler({ db, queue, finder }) }) });
  pipe.db.data.settings.defaultRoots = { movie: 'movie', tv: 'tv' };
  const app = await pipe.api({ tmdb });
  const root = app.base.replace(/\/api$/, '');
  const key = pipe.db.data.apiKey!;
  async function call(method: string, path: string, body?: unknown, auth: string | null = key, as: 'query' | 'header' = 'query') {
    const url = `${root}${path}${auth && as === 'query' ? `${path.includes('?') ? '&' : '?'}apikey=${auth}` : ''}`;
    const res = await fetch(url, { method, headers: { ...(auth && as === 'header' ? { 'x-api-key': auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, version: res.headers.get('x-application-version'), body: await res.json().catch(() => undefined) };
  }
  return { pipe, app, root, key, call, radarr: new FakeRadarr(`${root}/radarr/api/v3`, key), sonarr: new FakeSonarr(`${root}/sonarr/api/v3`, key) };
}

async function eventually<T>(read: () => Promise<T>, done: (value: T) => boolean, timeoutMs = 8_000) {
  const end = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < end) {
    await new Promise((resolve) => setTimeout(resolve, 20));
    value = await read();
  }
  expect(done(value)).toBe(true);
  return value;
}

const RELEASE = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
// What MediaRequestSubscriber gives to addMovie for a request on a server with the default settings.
const movieOptions = (rootFolderPath: string, extra: Partial<RadarrMovieOptions> = {}): RadarrMovieOptions => ({
  profileId: 1,
  qualityProfileId: 1,
  rootFolderPath,
  minimumAvailability: 'released',
  title: 'Movie Name',
  tmdbId: 603,
  year: 2019,
  monitored: true,
  tags: [],
  searchNow: true,
  ...extra,
});
// What MediaRequestSubscriber gives to addSeries. Seerr sets seasonFolder to false by default.
const seriesOptions = (rootFolderPath: string, extra: Partial<AddSeriesOptions> = {}): AddSeriesOptions => ({
  profileId: 1,
  rootFolderPath,
  title: 'Show Name',
  tvdbid: 81189,
  seasons: [1],
  seasonFolder: false,
  seriesType: 'standard',
  tags: [],
  monitored: true,
  monitorNewItems: 'all',
  searchNow: true,
  ...extra,
});

describe('Seerr request for a movie', () => {
  it('goes from the connection test to a completed import, and Seerr sees each step', async () => {
    rig = await start();
    const { pipe, radarr } = rig;
    pipe.tracker.state.items = [{ title: RELEASE, size: 100 * 120 * MIB }];

    // The connection test in the settings of Seerr.
    expect(await radarr.getSystemStatus()).toMatchObject({ appName: 'Radarr', version: '5.0.0.0', urlBase: '/radarr' });
    expect(await radarr.getProfiles()).toEqual([
      { id: 1, name: '1080p' },
      { id: 2, name: '2160p' },
    ]);
    const folders = await radarr.getRootFolders();
    expect(folders).toMatchObject([{ path: pipe.folders.movies, accessible: true }]);
    expect(folders[0].freeSpace).toBeGreaterThan(0);
    expect(await radarr.getTags()).toEqual([]);

    // The request.
    radarr.calls.length = 0;
    const movie = await radarr.addMovie(movieOptions(pipe.folders.movies));
    expect(radarr.calls).toEqual(['GET /movie/lookup?term=tmdb:603', 'POST /movie']);
    expect(movie).toMatchObject({ id: 603, tmdbId: 603, titleSlug: '603', monitored: true, hasFile: false, isAvailable: true, qualityProfileId: 1, rootFolderPath: pipe.folders.movies });
    expect(pipe.db.data.titles['movie:603']).toMatchObject({ preset: 'p1080', rootId: 'movie', paused: false, manualRelease: false });

    // The search and the grab run in ladarr. The download tracker of Seerr asks for the queue.
    await until(() => pipe.db.data.queue['movie:603']?.stage === 'downloading');
    await radarr.refreshMonitoredDownloads();
    const [item] = await radarr.getQueue();
    expect(item).toMatchObject({ movieId: 603, title: RELEASE, status: 'downloading', protocol: 'torrent' });
    expect(item.downloadId.toLowerCase()).toBe(hashOf(RELEASE));
    expect(item.sizeleft).toBeLessThanOrEqual(item.size);
    // The scanner of Seerr sees a monitored movie without a file: Seerr shows it as processing.
    expect((await radarr.getMovies()).find((m: any) => m.tmdbId === 603)).toMatchObject({ hasFile: false, monitored: true });

    pipe.complete(RELEASE, { [`${RELEASE}.mkv`]: 'video-data' });
    await until(() => pipe.db.data.queue['movie:603']?.stage === 'available');

    // The scanner and the availability sync of Seerr see the file.
    expect((await radarr.getMovies()).find((m: any) => m.tmdbId === 603)).toMatchObject({ id: 603, hasFile: true, monitored: true });
    expect(await radarr.getLibraryMoviesByTmdbId(603)).toHaveLength(1);
    const read = await radarr.getMovie(603);
    expect(read.hasFile).toBe(true);
    const path = join(pipe.folders.movies, 'Movie Name (2019)/Movie Name (2019).mkv');
    expect(read.movieFile).toMatchObject({ path, relativePath: 'Movie Name (2019).mkv', size: 10 });
    expect(readFileSync(path, 'utf8')).toBe('video-data');
    expect(await radarr.getQueue()).toEqual([]);

    // A second request for the same movie adds nothing.
    radarr.calls.length = 0;
    expect(await radarr.addMovie(movieOptions(pipe.folders.movies))).toMatchObject({ id: 603, hasFile: true });
    expect(radarr.calls).toEqual(['GET /movie/lookup?term=tmdb:603']);
  });

  it('sets a paused movie to monitored and searches it with a command that ends when the search ends', async () => {
    rig = await start();
    const { pipe, app, radarr } = rig;
    expect((await app.post('/library', { mediaType: 'movie', tmdbId: 603, add: 'paused' })).status).toBe(201);
    pipe.tracker.state.items = [{ title: RELEASE, size: 100 * 120 * MIB }];
    expect(pipe.tracker.state.searches).toHaveLength(0);

    radarr.calls.length = 0;
    const movie = await radarr.addMovie(movieOptions(pipe.folders.movies));
    expect(radarr.calls).toEqual(['GET /movie/lookup?term=tmdb:603', 'PUT /movie', 'POST /command']);
    expect(movie).toMatchObject({ id: 603, monitored: true });
    expect(pipe.db.data.titles['movie:603']!.paused).toBe(false);

    const command = pipe.db.data.compat.commands[1]!;
    expect(command).toMatchObject({ id: 1, name: 'MoviesSearch', body: { name: 'MoviesSearch', movieIds: [603] }, entries: ['movie:603'], jobs: [expect.any(String)] });
    const done = await eventually(() => radarr.getCommand(1), (value) => value.status === 'completed');
    expect(done).toMatchObject({ id: 1, name: 'MoviesSearch', result: 'successful' });
    // The command ended because the search ended: the search found the release.
    expect(pipe.db.data.queue['movie:603']!.search).toMatchObject({ result: 'grabbed' });
    expect(['fetching', 'sending', 'downloading']).toContain(pipe.db.data.queue['movie:603']!.stage);

    // The movie is monitored and in the queue. A search command has nothing to do, and it says so.
    expect(await radarr.searchMovie(603)).toMatchObject({ id: 2, status: 'completed', result: 'successful', message: expect.stringContaining('Nothing to search') });
  });

  it('keeps the command and its ID after a restart', async () => {
    rig = await start();
    const { pipe, radarr, key } = rig;
    pipe.tracker.state.items = [];
    await rig.app.post('/library', { mediaType: 'movie', tmdbId: 603, add: 'all' });
    await eventually(async () => pipe.db.data.queue['movie:603'], (entry) => entry?.branch === 'waiting');

    // The command is queued while its search runs, and the answer says so.
    const first = await radarr.searchMovie(603);
    expect(first).toMatchObject({ id: 1, status: 'queued', result: 'unknown' });
    const ended = await eventually(() => radarr.getCommand(1), (value) => value.status === 'completed');
    // A search with no release is not a failure.
    expect(ended).toMatchObject({ result: 'successful' });
    expect(pipe.db.data.queue['movie:603']!.search).toMatchObject({ result: 'no_results' });

    // A new process reads the same data.
    const copy = await open('unused.json');
    Object.assign(copy.data, JSON.parse(JSON.stringify(pipe.db.data)));
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    try {
      const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}/radarr/api/v3`;
      expect(await (await fetch(`${base}/command/1?apikey=${key}`)).json()).toMatchObject({ id: 1, name: 'MoviesSearch', status: 'completed', result: 'successful' });
      expect(await (await fetch(`${base}/command?apikey=${key}`)).json()).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      server.close();
    }
    expect(copy.data.compat.commandSeq).toBe(1);
  });

  it('gives each command its own ID when two commands arrive at the same time', async () => {
    rig = await start();
    const { radarr, sonarr } = rig;
    // Seerr refreshes its Radarr and its Sonarr servers together.
    const [first, second, third] = await Promise.all([radarr.refreshMonitoredDownloads(), sonarr.refreshMonitoredDownloads(), radarr.refreshMonitoredDownloads()]);
    expect([first.id, second.id, third.id].sort()).toEqual([1, 2, 3]);
    expect(Object.keys(rig.pipe.db.data.compat.commands).sort()).toEqual(['1', '2', '3']);
    expect(rig.pipe.db.data.compat.commandSeq).toBe(3);
  });

  it('keeps the end of a search command when the same entry is searched again', async () => {
    // The indexer allows one request each second, so the second search stays pending for a while.
    rig = await start({ indexer: { delaySeconds: 1 } });
    const { pipe, radarr, app } = rig;
    pipe.tracker.state.items = [];
    await app.post('/library', { mediaType: 'movie', tmdbId: 603, add: 'all' });
    await eventually(async () => pipe.db.data.queue['movie:603'], (entry) => entry?.branch === 'waiting', 15_000);
    // A waiting search for a later time is not work that the command waits for.
    const jobsLeft = () =>
      Object.values(pipe.db.data.jobs).filter(
        (job) =>
          job.type === 'queue.search' &&
          (job.payload as { entryIds: string[] }).entryIds.includes('movie:603') &&
          (job.state === 'running' || (job.state === 'waiting' && job.runAt <= Date.now())),
      ).length;
    await until(() => jobsLeft() === 0);

    const first = await radarr.searchMovie(603);
    await until(() => pipe.db.data.queue['movie:603']!.branch === 'waiting' && jobsLeft() === 0, 15_000);
    // The next search of the entry stays in the queue, and the first command does not wait for it.
    expect(Object.values(pipe.db.data.jobs).filter((job) => job.type === 'queue.search' && job.state === 'waiting' && job.runAt > Date.now()).map((job) => (job.payload as { entryIds: string[] }).entryIds)).toEqual([['movie:603']]);
    // The first search ended. The second search starts before anyone reads the first command.
    const second = await radarr.searchMovie(603);
    expect(second).toMatchObject({ id: first.id + 1, status: 'queued' });
    expect(await radarr.getCommand(first.id)).toMatchObject({ status: 'completed', result: 'successful' });
    expect(await radarr.getCommand(second.id)).toMatchObject({ result: 'unknown' });
    await eventually(() => radarr.getCommand(second.id), (value) => value.status === 'completed', 15_000);
  }, 40_000);

  it('refuses a search command for a series whose episodes are not loaded', async () => {
    rig = await start();
    const { pipe, app, sonarr } = rig;
    expect((await app.post('/library', { mediaType: 'tv', tmdbId: 1396, add: 'paused' })).status).toBe(201);
    await until(() => pipe.db.data.titles['tv:1396']!.episodesLoadedAt);
    pipe.db.data.titles['tv:1396']!.episodesLoadedAt = null;
    await expect(sonarr.runCommand('MissingEpisodeSearch', { seriesId: 1396 })).rejects.toMatchObject({ status: 409, data: { message: 'Conflict' } });
    expect(pipe.db.data.compat.commands).toEqual({});
  });

  it('answers the refresh of the download tracker, and refuses a command it does not know', async () => {
    rig = await start();
    const { radarr, sonarr, call } = rig;
    expect(await radarr.refreshMonitoredDownloads()).toMatchObject({ id: 1, name: 'RefreshMonitoredDownloads', status: 'completed', result: 'successful' });
    expect(await sonarr.refreshMonitoredDownloads()).toMatchObject({ id: 2, status: 'completed' });
    await expect(radarr.runCommand('RescanMovie', { movieId: 603 })).rejects.toMatchObject({ status: 501, data: { message: 'NotSupported' } });
    // The Sonarr search command does not belong on the Radarr path.
    await expect(radarr.runCommand('MissingEpisodeSearch', { seriesId: 1396 })).rejects.toMatchObject({ status: 501 });
    expect((await call('POST', '/radarr/api/v3/command', { name: 'MoviesSearch', movieIds: [] })).status).toBe(400);
    expect((await call('POST', '/radarr/api/v3/command', { name: 'MoviesSearch', movieIds: [603] })).body).toMatchObject({ message: 'NotFound' });
    expect((await call('POST', '/radarr/api/v3/command', {})).status).toBe(400);
    expect((await call('GET', '/radarr/api/v3/command/77')).status).toBe(404);
    // The refused calls made no command.
    expect(Object.keys(rig.pipe.db.data.compat.commands)).toEqual(['1', '2']);
  });
});

describe('Seerr request for a series', () => {
  it('adds the requested seasons, searches only them, and counts the files of each season', async () => {
    rig = await start();
    const { pipe, sonarr } = rig;
    const pack = 'Show.Name.S01.1080p.WEB-DL.DDP5.1-GRP';
    pipe.tracker.state.items = [{ title: pack, size: 2 * 60 * 45 * MIB }];

    expect(await sonarr.getSystemStatus()).toMatchObject({ appName: 'Sonarr', version: '4.0.0.0', urlBase: '/sonarr' });
    expect(await sonarr.getRootFolders()).toMatchObject([{ path: pipe.folders.tv }]);
    // Sonarr 4 has no language profiles, and Seerr does not ask for them.
    await expect(sonarr.getLanguageProfiles()).rejects.toMatchObject({ status: 501 });

    sonarr.calls.length = 0;
    const series = await sonarr.addSeries(seriesOptions(pipe.folders.tv));
    expect(sonarr.calls).toEqual(['GET /series/lookup?term=tvdb:81189', 'POST /series']);
    expect(series).toMatchObject({ id: 1396, tvdbId: 81189, tmdbId: 1396, titleSlug: '1396', monitored: true, rootFolderPath: pipe.folders.tv, qualityProfileId: 1 });
    expect(series.seasons.map((s: any) => [s.seasonNumber, s.monitored])).toEqual([[0, false], [1, true], [2, false]]);
    // Only the seasons that differ from the policy are saved as choices.
    expect(pipe.db.data.titles['tv:1396']!.seasonOverrides).toEqual({ 2: 'unmonitored' });

    // The first search waits for the episodes. If it runs too early, it tries again after the backoff of the job queue, like the add form does.
    await until(() => ['tv:1396:1x1', 'tv:1396:1x2'].every((id) => pipe.db.data.queue[id]?.stage === 'downloading'), 12_000);
    expect(Object.keys(pipe.db.data.queue).sort()).toEqual(['tv:1396:1x1', 'tv:1396:1x2']);
    await sonarr.refreshMonitoredDownloads();
    const queue = await sonarr.getQueue();
    // The query page and pageSize cut the list.
    expect(await rig.call('GET', '/sonarr/api/v3/queue?page=2&pageSize=1')).toMatchObject({ status: 200, body: { page: 2, pageSize: 1, totalRecords: 2, records: [{ episodeId: 9102 }] } });
    expect(queue.map((item: any) => [item.seriesId, item.episode.seasonNumber, item.episode.episodeNumber, item.episode.id])).toEqual([
      [1396, 1, 1, 9101],
      [1396, 1, 2, 9102],
    ]);

    // The scanner of Seerr reads the season statistics while the files are missing.
    const before = (await sonarr.getSeries()).find((s: any) => s.tvdbId === 81189);
    expect(before.seasons.find((s: any) => s.seasonNumber === 1)).toMatchObject({ monitored: true, statistics: { episodeFileCount: 0, totalEpisodeCount: 2 } });

    pipe.complete(pack, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two' });
    await until(() => ['tv:1396:1x1', 'tv:1396:1x2'].every((id) => pipe.db.data.queue[id]?.stage === 'available'));

    const listed = (await sonarr.getSeries()).find((s: any) => s.tvdbId === 81189);
    expect(listed.seasons.map((s: any) => [s.seasonNumber, s.monitored, s.statistics.episodeFileCount, s.statistics.totalEpisodeCount])).toEqual([
      [0, false, 0, 1],
      [1, true, 2, 2],
      [2, false, 0, 1],
    ]);
    expect(listed.seasons[1].statistics).toMatchObject({ episodeCount: 2, sizeOnDisk: 6, percentOfEpisodes: 100 });
    // The availability sync of Seerr reads the series by its ID.
    expect((await sonarr.getSeriesById(1396)).statistics).toMatchObject({ episodeFileCount: 2, totalEpisodeCount: 4 });
    expect(await sonarr.getLibrarySeriesByTvdbId(81189)).toHaveLength(1);
    expect(await sonarr.getLibrarySeriesByTvdbId(1)).toEqual([]);
    expect(await sonarr.getQueue()).toEqual([]);

    // The ID of an episode is a TMDB ID. The resource does not call it a TVDB ID.
    const episodes = await sonarr.getEpisodes(1396);
    expect(episodes.filter((e: any) => e.seasonNumber === 1).map((e: any) => [e.id, e.hasFile, e.monitored])).toEqual([
      [9101, true, true],
      [9102, true, true],
    ]);
    expect(episodes.every((e: any) => !('tvdbId' in e))).toBe(true);

    // A season that the user turns off keeps its files in the count.
    expect((await rig.app.patch('/library/tv:1396/seasons/1', { override: 'unmonitored' })).status).toBe(200);
    const off = (await sonarr.getSeriesById(1396)).seasons[1];
    expect(off).toMatchObject({ monitored: false, statistics: { episodeFileCount: 2, episodeCount: 2, totalEpisodeCount: 2, percentOfEpisodes: 100 } });
    const files = Object.values(pipe.db.data.files).map((f) => f.path).sort();
    expect(files.map((f) => existsSync(join(pipe.folders.tv, f)))).toEqual([true, true]);
  }, 20_000);

  it('updates a series that exists: seasons, episodes, and a search command', async () => {
    rig = await start();
    const { pipe, app, sonarr } = rig;
    pipe.tracker.state.items = [];
    expect((await app.post('/library', { mediaType: 'tv', tmdbId: 1396, add: 'paused' })).status).toBe(201);
    await until(() => pipe.db.data.titles['tv:1396']!.episodesLoadedAt);
    // The user turned one episode of season 2 off. Season 2 is not monitored as a whole.
    expect((await app.patch('/library/tv:1396/episodes/2/1', { override: 'unmonitored' })).status).toBe(200);
    expect((await sonarr.getSeriesById(1396)).seasons.map((s: any) => s.monitored)).toEqual([false, true, false]);

    sonarr.calls.length = 0;
    const series = await sonarr.addSeries(seriesOptions(pipe.folders.tv, { seasons: [2] }));
    expect(sonarr.calls).toEqual(['GET /series/lookup?term=tvdb:81189', 'PUT /series', 'GET /episode?seriesId=1396', 'PUT /episode/monitor', 'POST /command']);
    expect(series).toMatchObject({ id: 1396, monitored: true });
    const title = pipe.db.data.titles['tv:1396']!;
    expect(title.paused).toBe(false);
    expect(title.seasonOverrides).toEqual({ 2: 'monitored' });
    expect(title.episodes.find((e) => e.tmdbId === 9201)!.override).toBe('monitored');

    const done = await eventually(() => sonarr.getCommand(1), (value) => value.status === 'completed');
    expect(done).toMatchObject({ name: 'MissingEpisodeSearch', body: { seriesId: 1396 }, result: 'successful' });
    // Three aired and monitored episodes had no file. Each one has a finished search.
    expect(Object.keys(pipe.db.data.queue).sort()).toEqual(['tv:1396:1x1', 'tv:1396:1x2', 'tv:1396:2x1']);
    expect(Object.values(pipe.db.data.queue).map((entry) => entry.branch)).toEqual(['waiting', 'waiting', 'waiting']);
  });
});

describe('refused and unsupported calls', () => {
  it('answers a missing or wrong key with 401, and takes the key from the header or the query', async () => {
    rig = await start();
    const { call, key } = rig;
    for (const path of ['/radarr/api/v3/system/status', '/sonarr/api/v3/system/status', '/radarr/api/v3/movie', '/sonarr/api/v3/command']) {
      expect((await call('GET', path, undefined, null)).status).toBe(401);
      const wrong = await call('GET', path, undefined, 'wrong');
      expect(wrong).toMatchObject({ status: 401, body: { message: 'Unauthorized' } });
      expect(wrong.body.detail).toContain('apikey');
    }
    expect((await call('GET', '/radarr/api/v3/system/status', undefined, key, 'header')).status).toBe(200);
    expect((await call('GET', '/radarr/api/v3/system/status', undefined, key, 'query')).version).toBe('5.0.0.0');
    expect((await call('GET', '/sonarr/api/v3/movie', undefined, key)).status).toBe(501);
  });

  it('names the right path when the path is wrong, also without the page fallback', async () => {
    rig = await start();
    const { call, root } = rig;
    for (const path of ['/radarr/api/v2/system/status', '/radarr/system/status', '/sonarr', '/api/v3/system/status']) {
      const res = await call('GET', path);
      expect(res.status, path).toBe(404);
      expect(res.body).toMatchObject({ message: 'NotFound', detail: expect.stringContaining('/radarr/api/v3') });
    }
    // The native API stays closed to the keyless call that Seerr would send to the wrong path.
    expect((await fetch(`${root}/api/v3/system/status`)).status).toBe(404);
  });

  it('names the URL base in the answer for a wrong path', async () => {
    const db = await open('unused.json');
    db.data.apiKey = 'secret';
    const server = createApp({ urlBase: '/ladarr' }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
      // The server has no TMDB key.
      const lookup = await fetch(`${base}/ladarr/radarr/api/v3/movie/lookup?term=tmdb:603&apikey=secret`);
      expect(lookup.status).toBe(503);
      expect(await lookup.json()).toMatchObject({ detail: 'The TMDB key is not set.' });
      const ok = await fetch(`${base}/ladarr/radarr/api/v3/system/status?apikey=secret`);
      expect(await ok.json()).toMatchObject({ appName: 'Radarr', urlBase: '/ladarr/radarr' });
      for (const path of ['/radarr/api/v3/system/status?apikey=secret', '/api/v3/system/status', '/ladarr/radarr/system/status']) {
        const res = await fetch(`${base}${path}`);
        expect(res.status, path).toBe(404);
        expect(await res.json()).toMatchObject({ detail: expect.stringContaining('/ladarr/radarr/api/v3') });
      }
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });

  it('answers the adapter paths and the page when the URL base is the name of an adapter', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-compat-web-'));
    writeFileSync(join(dir, 'index.html'), '<html><head><base href="/" /></head><body>app</body></html>');
    const db = await open('unused.json');
    db.data.apiKey = 'secret';
    const server = createApp({ urlBase: '/sonarr', webDir: dir }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as import('node:net').AddressInfo).port}`;
    try {
      for (const name of ['sonarr', 'radarr']) {
        const res = await fetch(`${base}/sonarr/${name}/api/v3/system/status?apikey=secret`);
        expect(await res.json(), name).toMatchObject({ urlBase: `/sonarr/${name}` });
      }
      // The page of the app is under the same base.
      const page = await fetch(`${base}/sonarr/library`);
      expect(page.status).toBe(200);
      expect(await page.text()).toContain('app');
      // The path without the URL base is outside the app, and the answer names the right paths.
      const outside = await fetch(`${base}/radarr/api/v3/system/status?apikey=secret`);
      expect(outside.status).toBe(404);
      expect(await outside.json()).toMatchObject({ detail: expect.stringContaining('/sonarr/radarr/api/v3') });
    } finally {
      server.closeAllConnections();
      server.close();
      rmSync(dir, { recursive: true });
    }
  });

  it('says that an operation is unsupported and changes nothing', async () => {
    rig = await start();
    const { pipe, radarr, sonarr, call } = rig;
    pipe.tracker.state.items = [];
    await radarr.addMovie(movieOptions(pipe.folders.movies, { searchNow: false }));
    await sonarr.addSeries(seriesOptions(pipe.folders.tv, { searchNow: false }));

    // Seerr deletes the files with the title. ladarr removes no file through this API.
    await expect(radarr.removeMovie(603)).rejects.toMatchObject({ status: 501, data: { message: 'NotSupported' } });
    await expect(sonarr.removeSeries(81189)).rejects.toMatchObject({ status: 501, data: { message: 'NotSupported' } });
    expect(Object.keys(pipe.db.data.titles).sort()).toEqual(['movie:603', 'tv:1396']);
    // ladarr has no tags.
    await expect(radarr.createTag('1-user')).rejects.toMatchObject({ status: 501 });
    await expect(sonarr.renameTag(1, 'x')).rejects.toMatchObject({ status: 501 });
    // Lookups by title, or by another ID.
    await expect(sonarr.getSeriesByTitle('Show Name')).rejects.toMatchObject({ status: 501, data: { detail: expect.stringContaining('tvdb:<ID>') } });
    expect((await call('GET', '/radarr/api/v3/movie/lookup?term=imdb:tt0133093')).status).toBe(501);
    expect((await call('GET', '/radarr/api/v3/movie/lookup?term=Movie')).status).toBe(501);
    // Any other path.
    expect((await call('GET', '/radarr/api/v3/series')).body).toMatchObject({ message: 'NotSupported', detail: 'GET /series is not supported.' });
    expect((await call('DELETE', '/radarr/api/v3/command/1')).status).toBe(501);
    expect((await call('GET', '/sonarr/api/v3/calendar')).status).toBe(501);
  });

  it('refuses a body that ladarr cannot keep, with the field in the answer', async () => {
    rig = await start();
    const { pipe, call } = rig;
    const movie = { tmdbId: 603, qualityProfileId: 1, rootFolderPath: pipe.folders.movies, monitored: true, tags: [], minimumAvailability: 'released' };
    const refused = async (path: string, body: unknown) => {
      const res = await call('POST', path, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
      return res.body.map((error: any) => error.propertyName);
    };
    expect(await refused('/radarr/api/v3/movie', { ...movie, rootFolderPath: '/nowhere' })).toEqual(['rootFolderPath']);
    // A root of the other media type is not a root for movies.
    expect(await refused('/radarr/api/v3/movie', { ...movie, rootFolderPath: pipe.folders.tv })).toEqual(['rootFolderPath']);
    expect(await refused('/radarr/api/v3/movie', { ...movie, qualityProfileId: 9 })).toEqual(['qualityProfileId']);
    expect(await refused('/radarr/api/v3/movie', { ...movie, tags: [3] })).toEqual(['tags']);
    expect(await refused('/radarr/api/v3/movie', { ...movie, minimumAvailability: 'inCinemas' })).toEqual(['minimumAvailability']);
    expect(await refused('/radarr/api/v3/movie', { ...movie, addOptions: { monitor: 'none' } })).toEqual(['addOptions']);
    expect(await refused('/radarr/api/v3/movie', { ...movie, tmdbId: 'x' })).toEqual(['tmdbId']);
    expect(await refused('/radarr/api/v3/movie', { ...movie, tmdbId: 999 })).toEqual(['tmdbId']);
    expect(await refused('/radarr/api/v3/movie', {})).toEqual(['tmdbId', 'qualityProfileId', 'rootFolderPath']);
    expect(pipe.db.data.titles).toEqual({});

    const series = { tvdbId: 81189, qualityProfileId: 1, rootFolderPath: pipe.folders.tv, monitored: true, tags: [], seriesType: 'standard', monitorNewItems: 'all' };
    expect(await refused('/sonarr/api/v3/series', { ...series, seriesType: 'daily' })).toEqual(['seriesType']);
    expect(await refused('/sonarr/api/v3/series', { ...series, monitorNewItems: 'none' })).toEqual(['monitorNewItems']);
    expect(await refused('/sonarr/api/v3/series', { ...series, seasons: [{ seasonNumber: 9, monitored: true }] })).toEqual(['seasons']);
    expect(await refused('/sonarr/api/v3/series', { ...series, seasons: 'all' })).toEqual(['seasons']);
    expect(await refused('/sonarr/api/v3/series', { ...series, addOptions: { monitor: 'all' } })).toEqual(['addOptions']);
    expect(await refused('/sonarr/api/v3/series', { ...series, tvdbId: 777 })).toEqual(['tvdbId']);
    expect(await refused('/sonarr/api/v3/series', { ...series, tvdbId: 5555 })).toEqual(['tvdbId']);
    expect(pipe.db.data.titles).toEqual({});

    // A series with two TMDB matches is not a lookup result.
    expect(await call('GET', '/sonarr/api/v3/series/lookup?term=tvdb:5555')).toMatchObject({ status: 409 });
    expect((await call('GET', '/sonarr/api/v3/series/lookup?term=tvdb:777')).body).toEqual([]);
    expect((await call('GET', '/radarr/api/v3/movie/lookup?term=tmdb:999')).body).toEqual([]);
    // TMDB does not answer.
    expect(await call('GET', '/radarr/api/v3/movie/lookup?term=tmdb:500')).toMatchObject({ status: 503, body: { message: 'ServiceUnavailable' } });
    expect((await call('POST', '/radarr/api/v3/movie', { ...movie, tmdbId: 500 })).status).toBe(503);

    // A root that the disk does not answer has no space values.
    pipe.db.data.roots.movie!.path = join(pipe.dir, 'gone');
    expect((await call('GET', '/radarr/api/v3/rootfolder')).body).toEqual([{ id: expect.any(Number), path: join(pipe.dir, 'gone'), accessible: false }]);
  });

  it('refuses a second add, and answers 404 for an ID that does not exist', async () => {
    rig = await start();
    const { pipe, radarr, sonarr, call } = rig;
    pipe.tracker.state.items = [];
    await radarr.addMovie(movieOptions(`${pipe.folders.movies}/`, { searchNow: false }));
    await sonarr.addSeries(seriesOptions(pipe.folders.tv, { searchNow: false }));
    // A second POST is not what Seerr sends, but another caller can send it.
    const movie = { tmdbId: 603, qualityProfileId: 1, rootFolderPath: pipe.folders.movies };
    expect(await call('POST', '/radarr/api/v3/movie', movie)).toMatchObject({ status: 400, body: [{ propertyName: 'tmdbId', errorMessage: 'This movie has already been added.' }] });
    expect(await call('POST', '/sonarr/api/v3/series', { tvdbId: 81189, qualityProfileId: 1, rootFolderPath: pipe.folders.tv })).toMatchObject({ status: 400, body: [{ errorMessage: 'This series has already been added.' }] });

    for (const [path, detail] of [
      ['/radarr/api/v3/movie/999', 'No movie has this ID.'],
      ['/radarr/api/v3/movie/abc', 'No movie has this ID.'],
      ['/sonarr/api/v3/series/999', 'No series has this ID.'],
      ['/sonarr/api/v3/episode?seriesId=999', 'No series has this ID.'],
    ] as const) {
      expect(await call('GET', path), path).toMatchObject({ status: 404, body: { message: 'NotFound', detail } });
    }
    expect((await call('PUT', '/radarr/api/v3/movie', { id: 999, qualityProfileId: 1, rootFolderPath: pipe.folders.movies })).status).toBe(404);
    expect((await call('PUT', '/sonarr/api/v3/episode/monitor', { episodeIds: [1], monitored: true })).status).toBe(404);
    expect((await call('PUT', '/sonarr/api/v3/episode/monitor', { episodeIds: 'x' })).status).toBe(400);
    // The ID of the series is not an ID of Radarr.
    expect((await call('GET', '/radarr/api/v3/movie/1396')).status).toBe(404);
  });
});

describe('what the adapters answer from the library', () => {
  it('keeps a movie that was added with another option set', async () => {
    rig = await start();
    const { pipe, call } = rig;
    pipe.tracker.state.items = [{ title: RELEASE, size: 100 * 120 * MIB }];
    const body = { tmdbId: 603, qualityProfileId: 2, rootFolderPath: `${pipe.folders.movies}/`, monitored: false, minimumAvailability: 'announced', addOptions: { searchForMovie: true } };
    const res = await call('POST', '/radarr/api/v3/movie', body);
    expect(res).toMatchObject({ status: 201, version: '5.0.0.0', body: { id: 603, monitored: false, minimumAvailability: 'announced', qualityProfileId: 2 } });
    expect(pipe.db.data.titles['movie:603']).toMatchObject({ preset: 'p2160', paused: true, manualRelease: true });
    // A paused movie is not searched, even when the call asks for it.
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pipe.tracker.state.searches).toHaveLength(0);
    expect(pipe.db.data.queue).toEqual({});
  });

  it('changes a movie and a series with PUT, and keeps the files in place', async () => {
    rig = await start();
    const { pipe, radarr, sonarr, call } = rig;
    pipe.tracker.state.items = [];
    await radarr.addMovie(movieOptions(pipe.folders.movies, { searchNow: false }));
    await sonarr.addSeries(seriesOptions(pipe.folders.tv, { searchNow: false }));
    await until(() => pipe.db.data.titles['tv:1396']!.episodesLoadedAt);
    pipe.db.data.roots.movie2 = { id: 'movie2', path: pipe.dir, mediaType: 'movie', dev: 0 };

    const movie = await radarr.getMovie(603);
    const put = await call('PUT', '/radarr/api/v3/movie', { ...movie, qualityProfileId: 2, minimumAvailability: 'announced', monitored: false, rootFolderPath: pipe.dir });
    expect(put).toMatchObject({ status: 202, body: { id: 603, monitored: false, qualityProfileId: 2, minimumAvailability: 'announced', rootFolderPath: pipe.dir } });
    expect(pipe.db.data.titles['movie:603']).toMatchObject({ preset: 'p2160', rootId: 'movie2', paused: true, manualRelease: true });

    // A movie with a file stays in its root folder.
    const title = pipe.db.data.titles['movie:603']!;
    title.fileId = 'f';
    pipe.db.data.files.f = { id: 'f', titleKey: title.key, path: 'Movie Name (2019)/Movie Name (2019).mkv', sizeBytes: 1, mtimeMs: 0, episodes: [], missing: false, addedAt: 0 };
    const back = await call('PUT', '/radarr/api/v3/movie', { ...movie, rootFolderPath: pipe.folders.movies });
    expect(back).toMatchObject({ status: 400, body: [{ propertyName: 'rootFolderPath' }] });
    expect(title.rootId).toBe('movie2');
    expect((await call('PUT', '/radarr/api/v3/movie', { ...movie, minimumAvailability: 'inCinemas' })).status).toBe(400);

    const series = await sonarr.getSeriesById(1396);
    const changed = await call('PUT', '/sonarr/api/v3/series', { ...series, qualityProfileId: 2, seriesType: 'anime', monitored: false });
    expect(changed).toMatchObject({ status: 202, body: { id: 1396, monitored: false, seriesType: 'anime', qualityProfileId: 2 } });
    expect(pipe.db.data.titles['tv:1396']).toMatchObject({ preset: 'p2160', seriesType: 'anime', paused: true });
    expect((await call('PUT', '/sonarr/api/v3/series', { ...series, seriesType: 'daily' })).status).toBe(400);
    expect((await call('PUT', '/sonarr/api/v3/series', { ...series, seasons: [{ seasonNumber: 7, monitored: true }] })).status).toBe(400);
  });

  it('does not start a search when the call does not ask for one', async () => {
    rig = await start();
    const { pipe, radarr } = rig;
    pipe.tracker.state.items = [{ title: RELEASE, size: 100 * 120 * MIB }];
    await radarr.addMovie(movieOptions(pipe.folders.movies, { searchNow: false }));
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(pipe.tracker.state.searches).toHaveLength(0);
    expect(pipe.db.data.queue).toEqual({});
    // The command starts it.
    await radarr.searchMovie(603);
    await until(() => pipe.db.data.queue['movie:603']);
  });

  it('keeps the series type anime', async () => {
    rig = await start();
    const { pipe, call } = rig;
    const res = await call('POST', '/sonarr/api/v3/series', { tvdbId: 81189, qualityProfileId: 2, rootFolderPath: pipe.folders.tv, seriesType: 'anime', seasonFolder: false });
    expect(res).toMatchObject({ status: 201, body: { seriesType: 'anime', qualityProfileId: 2, seasonFolder: true } });
    expect(pipe.db.data.titles['tv:1396']).toMatchObject({ seriesType: 'anime', preset: 'p2160' });
  });

  it('does not show a series that TMDB does not link to a TVDB ID', async () => {
    rig = await start();
    const { pipe, call } = rig;
    expect((await call('POST', '/sonarr/api/v3/series', { tvdbId: 81189, qualityProfileId: 1, rootFolderPath: pipe.folders.tv })).status).toBe(201);
    pipe.db.data.titles['tv:1396']!.meta.tvdbId = null;
    expect((await call('GET', '/sonarr/api/v3/series')).body).toEqual([]);
    expect((await call('GET', '/sonarr/api/v3/series/1396')).status).toBe(404);
    expect((await call('GET', '/sonarr/api/v3/series?tvdbId=81189')).body).toEqual([]);
  });
});

it('writes a time span like Sonarr and Radarr', () => {
  expect(timespan(0)).toBe('00:00:00');
  expect(timespan(3661)).toBe('01:01:01');
  expect(timespan(86_400 + 3661)).toBe('1.01:01:01');
  expect(timespan(3 * 86_400)).toBe('3.00:00:00');
});
