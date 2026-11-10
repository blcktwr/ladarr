import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { availability, isMonitored, mergeEpisodes, seriesCounts, titleKey, type Episode, type Title } from '../../src/library/library.ts';
import { metadataRefreshHandler } from '../../src/jobs/metadata-refresh.ts';
import { createQueue } from '../../src/library/downloads/queue.ts';
import { createEvents } from '../../src/core/events.ts';
import { enqueue } from '../../src/core/jobs.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { withOutboundRequests } from '../../src/core/outbound.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';
import { startTestApp } from '../helpers/test-app.ts';

const NOW = Date.UTC(2024, 5, 1);
const clock = { now: NOW, files: { f: { missing: false }, both: { missing: false } } };

const episode = (season: number, number: number, airDate: string | null, extra: Partial<Episode> = {}): Episode => ({
  tmdbId: season * 100 + number,
  season,
  number,
  name: `Episode ${number}`,
  airDate,
  runtime: 45,
  override: null,
  fileId: null,
  ...extra,
});

const title = (extra: Partial<Title> = {}): Title => ({
  key: 'tv:1',
  mediaType: 'tv',
  tmdbId: 1,
  meta: { mediaType: 'tv', tmdbId: 1, title: 'Show', year: 2020, overview: '', posterPath: null, originalLanguage: 'en', originalTitle: 'Show', aliases: [], date: null, status: 'Returning Series', rating: null, votes: 0, backdropPath: null, runtime: 45, imdbId: null, tvdbId: null, releaseDates: [], seasons: [] },
  refreshedAt: NOW,
  addedAt: NOW,
  paused: false,
  policy: 'all',
  futureFrom: NOW,
  seriesType: 'standard',
  preset: null,
  rootId: 'root',
  folder: null,
  manualRelease: false,
  seasonOverrides: {},
  episodesLoadedAt: NOW,
  episodes: [],
  fileId: null,
  ...extra,
});

describe('monitoring', () => {
  const past = episode(1, 1, '2020-01-01');
  const today = episode(1, 2, '2024-06-01');
  const later = episode(1, 3, '2999-01-01');
  const unknown = episode(1, 4, null);
  const special = episode(0, 1, '2020-01-01');

  it('monitors every regular episode with the All policy, but not specials', () => {
    const show = title({ policy: 'all' });
    expect([past, today, later, unknown, special].map((e) => isMonitored(show, e))).toEqual([true, true, true, true, false]);
  });

  it('monitors only episodes that air from the boundary with the Future policy', () => {
    const show = title({ policy: 'future', futureFrom: NOW });
    expect([past, today, later, unknown].map((e) => isMonitored(show, e))).toEqual([false, true, true, true]);
  });

  it('lets an episode choice beat a season choice, and a season choice beat the policy', () => {
    const show = title({ policy: 'future', futureFrom: NOW, seasonOverrides: { 1: 'monitored' } });
    expect(isMonitored(show, past)).toBe(true);
    expect(isMonitored(show, { ...past, override: 'unmonitored' })).toBe(false);
    expect(isMonitored(title({ seasonOverrides: { 0: 'monitored' } }), special)).toBe(true);
  });
});

describe('series counts and availability', () => {
  it('counts only monitored episodes that have aired', () => {
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'f' }), episode(1, 2, '2020-01-08'), episode(1, 3, '2999-01-01'), episode(1, 4, '2020-02-01', { override: 'unmonitored' })] });
    expect(seriesCounts(show, clock)).toEqual({ total: 4, eligible: 2, available: 1, upcoming: 1 });
    expect(availability(show, clock)).toBe('missing');
  });

  it('counts each episode of a multi-episode file once', () => {
    const show = title({ episodes: [episode(1, 1, '2020-01-01', { fileId: 'both' }), episode(1, 2, '2020-01-08', { fileId: 'both' })] });
    expect(seriesCounts(show, clock)).toMatchObject({ eligible: 2, available: 2 });
    expect(availability(show, clock)).toBe('available');
  });

  it('shows missing episodes for an ended series', () => {
    const show = title({ meta: { ...title().meta, status: 'Ended' }, episodes: [episode(1, 1, '2010-01-01')] });
    expect(availability(show, clock)).toBe('missing');
  });

  it('waits for release when nothing monitored has aired', () => {
    expect(availability(title({ episodes: [episode(1, 1, '2999-01-01')] }), clock)).toBe('waiting');
    expect(availability(title({ episodes: [] }), clock)).toBe('waiting');
  });
});

describe('movie availability', () => {
  const movie = (releaseDates: Title['meta']['releaseDates'], extra: Partial<Title> = {}) =>
    title({ key: 'movie:1', mediaType: 'movie', meta: { ...title().meta, mediaType: 'movie', releaseDates }, ...extra });

  it('does not use a theatrical release as availability', () => {
    expect(availability(movie([{ region: 'US', kind: 'theatrical', date: '2020-01-01T00:00:00.000Z' }]), clock)).toBe('waiting');
  });

  it('uses a past digital or physical date in any region', () => {
    expect(availability(movie([{ region: 'US', kind: 'digital', date: '2020-07-15T00:00:00.000Z' }]), clock)).toBe('missing');
    expect(availability(movie([{ region: 'US', kind: 'physical', date: '2020-07-15T00:00:00.000Z' }]), clock)).toBe('missing');
  });

  it('waits for a future date and no date', () => {
    expect(availability(movie([{ region: 'US', kind: 'digital', date: '2999-01-01T00:00:00.000Z' }]), clock)).toBe('waiting');
    expect(availability(movie([{ region: 'GB', kind: 'digital', date: '2020-01-01T00:00:00.000Z' }]), clock)).toBe('missing');
    expect(availability(movie([]), clock)).toBe('waiting');
  });

  it('lets a manual override allow a search, and a file make the movie available', () => {
    expect(availability(movie([], { manualRelease: true }), clock)).toBe('missing');
    expect(availability(movie([], { fileId: 'f' }), clock)).toBe('available');
  });
});

describe('episode merge', () => {
  it('keeps the choices and files of the user on a refresh', () => {
    const before = [episode(1, 1, '2020-01-01', { override: 'unmonitored', fileId: 'f' })];
    const after = mergeEpisodes(before, [{ tmdbId: 5, season: 1, number: 1, name: 'New name', airDate: '2020-01-02', runtime: 50 }]);
    expect(after).toEqual([{ tmdbId: 5, season: 1, number: 1, name: 'New name', airDate: '2020-01-02', runtime: 50, override: 'unmonitored', fileId: 'f' }]);
  });

  it('drops a removed episode unless the user made a choice about it or it has a file', () => {
    const before = [episode(1, 1, null), episode(1, 2, null, { override: 'monitored' }), episode(1, 3, null, { fileId: 'f' })];
    expect(mergeEpisodes(before, []).map((e) => e.number)).toEqual([2, 3]);
  });

  it('sorts by season and number', () => {
    const fetched = [episode(1, 2, null), episode(0, 1, null), episode(1, 1, null)];
    expect(mergeEpisodes([], fetched).map((e) => [e.season, e.number])).toEqual([[0, 1], [1, 1], [1, 2]]);
  });
});

describe('title identity', () => {
  it('keeps a movie and a series with the same TMDB ID apart', () => {
    expect(titleKey('movie', 603)).not.toBe(titleKey('tv', 603));
  });
});

// ---- the HTTP flow, with a fake TMDB and real folders ----

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
let tmdbDown = false;
const fakeFetch = (async (input: URL | string) => {
  const url = new URL(String(input));
  const path = url.pathname.replace('/3', '');
  if (tmdbDown) return json({}, 503);
  if (path === '/movie/603') {
    return json({
      id: 603, title: 'The Matrix', original_title: 'The Matrix', original_language: 'en', overview: 'x', release_date: '1999-03-31', status: 'Released', runtime: 136, vote_count: 10, vote_average: 8, poster_path: '/m.jpg',
      release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 3, release_date: '1999-03-31T00:00:00.000Z' }, { type: 4, release_date: '2020-07-15T00:00:00.000Z' }] }] },
    });
  }
  if (path === '/movie/603/credits') return json({ cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Neo', profile_path: '/k.jpg' }] });
  if (path === '/movie/603/recommendations') return json({ results: [{ id: 604, title: 'The Matrix Reloaded', release_date: '2003-05-15', poster_path: '/r.jpg' }] });
  if (path === '/person/6384') return json({ id: 6384, name: 'Keanu Reeves', profile_path: '/k.jpg', also_known_as: ['Keanu Charles Reeves'], popularity: 28.5, combined_credits: { cast: [{ id: 603, media_type: 'movie', title: 'The Matrix', release_date: '1999-03-31' }, { id: 604, media_type: 'movie', title: 'The Matrix Reloaded', release_date: '2003-05-15' }] } });
  if (path === '/tv/603') return json({ id: 603, name: 'Same Number Show', first_air_date: '2010-01-01', status: 'Ended', seasons: [] });
  if (path === '/tv/1396') {
    return json({
      id: 1396, name: 'Breaking Bad', original_name: 'Breaking Bad', first_air_date: '2008-01-20', status: 'Ended', external_ids: { tvdb_id: 81189 },
      seasons: [{ season_number: 0, episode_count: 1 }, { season_number: 1, episode_count: 4 }, { season_number: 2, episode_count: 0 }],
    });
  }
  if (path === '/tv/1396/season/0') return json({ episodes: [{ id: 1, episode_number: 1, name: 'Special', air_date: '2009-01-01' }] });
  if (path === '/tv/1396/season/1') {
    return json({ episodes: [
      { id: 10, episode_number: 1, name: 'Pilot', air_date: '2008-01-20' },
      { id: 11, episode_number: 2, name: 'Cat in the Bag', air_date: '2008-01-27' },
      { id: 12, episode_number: 3, name: 'Next year', air_date: '2999-01-01' },
      { id: 13, episode_number: 4, name: 'TBA', air_date: null },
    ] });
  }
  if (path === '/tv/2000') {
    return json({
      id: 2000, name: 'Two Seasons', original_name: 'Two Seasons', first_air_date: '2001-01-01', status: 'Ended',
      seasons: [{ season_number: 1, episode_count: 2 }, { season_number: 2, episode_count: 2 }],
    });
  }
  if (path === '/tv/2000/season/1') return json({ episodes: [{ id: 21, episode_number: 1, name: 'One', air_date: '2001-01-01' }, { id: 22, episode_number: 2, name: 'Two', air_date: '2001-01-08' }] });
  if (path === '/tv/2000/season/2') return json({ episodes: [{ id: 23, episode_number: 1, name: 'Three', air_date: '2002-01-01' }, { id: 24, episode_number: 2, name: 'Four', air_date: '2002-01-08' }] });
  return json({}, 404);
}) as unknown as typeof fetch;

describe('library API', () => {
  let app: Awaited<ReturnType<typeof startTestApp>>;
  let dir: string;
  let refresh: (key: string) => Promise<void>;

  beforeAll(async () => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'ladarr-library-')));
    const tmdb = createTmdb({ apiKey: 'k', fetch: fakeFetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 });
    const events = createEvents();
    app = await startTestApp({ tmdb, events });
    const handler = metadataRefreshHandler({ tmdb, events });
    refresh = (key) => handler.run({ payload: { key } } as never, { signal: new AbortController().signal });
  });
  afterAll(() => {
    app.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not add a title before the setup made the folders', async () => {
    expect((await app.post('/library', { mediaType: 'movie', tmdbId: 603 })).body).toEqual({ error: 'root_required' });
  });

  it('adds a movie with the default folder, and refuses a second add', async () => {
    mkdirSync(join(dir, 'movies'));
    mkdirSync(join(dir, 'series'));
    const movies = await app.post('/roots', { path: join(dir, 'movies'), mediaType: 'movie' });
    await app.post('/roots', { path: join(dir, 'series'), mediaType: 'tv' });

    // The add returns with the facts that the page has. The refresh job brings the TMDB ones.
    const summary = { title: 'The Matrix', year: 1999, posterPath: '/m.jpg' };
    const added = await app.post('/library', { mediaType: 'movie', tmdbId: 603, summary });
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ jobId: expect.any(String), title: { key: 'movie:603', title: 'The Matrix', availability: 'waiting', paused: false, rootId: movies.body.id, preset: 'p1080', metaLoadedAt: null } });
    await refresh('movie:603');
    expect((await app.get('/library/movie:603')).body.title).toMatchObject({ title: 'The Matrix', availability: 'missing', metaLoadedAt: expect.any(Number) });
    expect((await app.post('/library', { mediaType: 'movie', tmdbId: 603 })).status).toBe(409);
  });

  it('gives the TMDB facts of a title, in the library or not', async () => {
    expect((await app.get('/search/movie/603')).body.title).toMatchObject({ mediaType: 'movie', tmdbId: 603, title: 'The Matrix', backdropPath: null, rating: 8, providerStatus: 'Released', libraryKey: 'movie:603', runtime: 136, imdbId: null, tvdbId: null });
    expect((await app.get('/search/tv/603')).body.title).toMatchObject({ title: 'Same Number Show', libraryKey: null });
    expect((await app.get('/search/tv/1396')).body.title).toMatchObject({ tvdbId: 81189 });
    expect((await app.get('/search/movie/999')).status).toBe(404);
    expect((await app.get('/search/book/1')).status).toBe(404);
  });

  it('gives every season and its episodes for a series that is not in the library', async () => {
    const { status, body } = await app.get('/search/tv/1396/seasons');
    expect(status).toBe(200);
    // The season with no episodes is not there, and the order is the one of TMDB.
    expect(body.seasons.map((s: { seasonNumber: number }) => s.seasonNumber)).toEqual([0, 1]);
    expect(body.seasons[0].episodes).toEqual([{ season: 0, number: 1, name: 'Special', airDate: '2009-01-01', runtime: null }]);
    expect(body.seasons[1].episodes).toEqual([
      { season: 1, number: 1, name: 'Pilot', airDate: '2008-01-20', runtime: null },
      { season: 1, number: 2, name: 'Cat in the Bag', airDate: '2008-01-27', runtime: null },
      { season: 1, number: 3, name: 'Next year', airDate: '2999-01-01', runtime: null },
      { season: 1, number: 4, name: 'TBA', airDate: null, runtime: null },
    ]);
    expect((await app.get('/search/movie/603/seasons')).body).toEqual({ error: 'not_found' });
    expect((await app.get('/search/tv/999/seasons')).status).toBe(404);
  });

  it('gives the cast and the recommendations of a title', async () => {
    expect((await app.get('/search/movie/603/cast')).body).toEqual({ cast: [{ id: 6384, name: 'Keanu Reeves', character: 'Neo', profilePath: '/k.jpg' }] });
    expect((await app.get('/search/movie/603/recommendations')).body.results).toMatchObject([{ mediaType: 'movie', tmdbId: 604, title: 'The Matrix Reloaded', year: 2003, libraryKey: null }]);
    expect((await app.get('/search/movie/999/cast')).status).toBe(404);
  });

  it('gives the movies of an actor and marks the ones in the library', async () => {
    const { person, credits } = (await app.get('/search/person/6384')).body;
    expect(person).toEqual({ id: 6384, name: 'Keanu Reeves', profilePath: '/k.jpg', alsoKnownAs: ['Keanu Charles Reeves'], popularity: 28.5 });
    expect(credits).toMatchObject([{ tmdbId: 604, libraryKey: null }, { tmdbId: 603, libraryKey: 'movie:603' }]);
    expect((await app.get('/search/person/999')).status).toBe(404);
    expect((await app.get('/search/person/x')).status).toBe(404);
  });

  it('keeps a movie and a series with the same TMDB ID apart', async () => {
    const added = await app.post('/library', { mediaType: 'tv', tmdbId: 603 });
    expect(added.status).toBe(201);
    expect(Object.keys(app.db.data.titles).sort()).toEqual(['movie:603', 'tv:603']);
    await app.del('/library/tv:603');
  });

  it.each([
    [{ mediaType: 'book', tmdbId: 1 }, 'invalid_title'],
    [{ mediaType: 'movie', tmdbId: 'x' }, 'invalid_title'],
    [{ mediaType: 'movie', tmdbId: 5, add: 'future' }, 'invalid_add_mode'],
    [{ mediaType: 'movie', tmdbId: 5, seriesType: 'anime' }, 'invalid_series_type'],
    [{ mediaType: 'tv', tmdbId: 5, seasonOverrides: { x: 'monitored' } }, 'invalid_season_overrides'],
    [{ mediaType: 'tv', tmdbId: 5, seasonOverrides: { 1: 'yes' } }, 'invalid_season_overrides'],
    [{ mediaType: 'movie', tmdbId: 5, seasonOverrides: { 1: 'monitored' } }, 'invalid_season_overrides'],
    [{ mediaType: 'tv', tmdbId: 5, preset: 'p480' }, 'invalid_preset'],
    [{ mediaType: 'tv', tmdbId: 5, rootId: 'nope' }, 'root_required'],
  ])('rejects the add request %j', async (body, error) => {
    expect((await app.post('/library', body)).body).toEqual({ error });
  });

  it('adds a title before TMDB answers, and leaves the facts to a queue job', async () => {
    // TMDB is down, so only an add that sends no request can succeed.
    tmdbDown = true;
    const summary = { title: 'The Matrix Reloaded', year: 2003, posterPath: '/r.jpg' };
    const added = await app.post('/library', { mediaType: 'movie', tmdbId: 604, summary });
    tmdbDown = false;
    expect(added.status).toBe(201);
    expect(added.body).toMatchObject({ title: { key: 'movie:604', title: 'The Matrix Reloaded', metaLoadedAt: null } });
    expect(app.db.data.jobs[added.body.jobId]).toMatchObject({ type: 'metadata.refresh', payload: { key: 'movie:604' } });
    await app.del('/library/movie:604');
  });

  it('adds a series at once and loads its episodes in a job', async () => {
    const added = await app.post('/library', { mediaType: 'tv', tmdbId: 1396, add: 'future', seriesType: 'anime' });
    expect(added.status).toBe(201);
    expect(added.body.jobId).toEqual(expect.any(String));
    expect(added.body.title).toMatchObject({ key: 'tv:1396', policy: 'future', seriesType: 'anime', episodesLoadedAt: null, availability: 'waiting' });
    expect(app.db.data.jobs[added.body.jobId]).toMatchObject({ type: 'metadata.refresh', payload: { key: 'tv:1396' } });
    // No season is monitored yet, so there is nothing to search now.
    expect(Object.values(app.db.data.jobs).some((job) => job.dedupeKey === 'initial:tv:1396')).toBe(false);

    await refresh('tv:1396');
    const { title } = (await app.get('/library/tv:1396')).body;
    expect(title.episodesLoadedAt).toEqual(expect.any(Number));
    expect(title.seasons.map((s: { seasonNumber: number; counts: { total: number } }) => [s.seasonNumber, s.counts.total])).toEqual([[0, 1], [1, 4], [2, 0]]);
  });

  it('links the line of a refresh to the TMDB requests that it sent', async () => {
    logToFile(join(dir, 'logs', 'ladarr.log'));
    await withOutboundRequests(() => refresh('tv:1396'));
    // The stream writes in the background, so closing it writes the whole line before the read.
    await closeLog();
    const [line] = (await recentLogs(200, { itemId: 'tv:1396' })).filter((entry) => entry.event === 'refreshed');
    expect(line).toMatchObject({
      type: 'catalog',
      titleKey: 'tv:1396',
      message: 'Refreshed the metadata from TMDB',
      requests: [{ system: 'TMDB', requestId: expect.stringMatching(/^req-[0-9a-f]{12}$/) }],
    });
    // The id finds every request of the refresh, so the log line opens all of them.
    const { requestId } = (line!.requests as { requestId: string; system: string }[])[0]!;
    const requests = await recentLogs(10, { kind: 'requests', requestId });
    expect(requests).toHaveLength(3);
    expect(requests.every((entry) => entry.system === 'TMDB' && entry.requestId === requestId)).toBe(true);
  });

  it('adds a series with the seasons that the user chose', async () => {
    const added = await app.post('/library', { mediaType: 'tv', tmdbId: 2000, add: 'future', seasonOverrides: { 1: 'monitored' } });
    expect(added.status).toBe(201);
    expect(app.db.data.titles['tv:2000']!.seasonOverrides).toEqual({ 1: 'monitored' });

    // The user chose season 1, so its old episodes are monitored. The old episodes of season 2 are not.
    await refresh('tv:2000');
    const title = app.db.data.titles['tv:2000']!;
    expect(title.episodes.map((e) => [e.season, e.number, isMonitored(title, e)])).toEqual([
      [1, 1, true],
      [1, 2, true],
      [2, 1, false],
      [2, 2, false],
    ]);
    await app.del('/library/tv:2000');
  });

  it('starts a re-added series with an empty queue', async () => {
    const body = { mediaType: 'tv', tmdbId: 2000, add: 'future', seasonOverrides: { 1: 'monitored' } };
    expect((await app.post('/library', body)).status).toBe(201);
    const queue = createQueue(createEvents(), () => {});
    const old = queue.ensure('tv:2000', 2, 1);
    queue.request(old, 'test');
    queue.endAttempt(old, 'cancelled');
    queue.move(old, { branch: 'cancelled', reason: null }, 'title removed');
    const job = enqueue({ type: 'queue.search', payload: { titleKey: 'tv:2000', season: 2, entryIds: [old.id] }, dedupeKey: 'search:tv:2000:2:tv:2000:2x1' });

    await app.del('/library/tv:2000');
    expect((await app.post('/library', body)).status).toBe(201);

    // The targets of the record that was removed do not return with the title.
    expect(Object.values(app.db.data.queue).filter((entry) => entry.titleKey === 'tv:2000')).toEqual([]);
    expect(app.db.data.jobs[job.id]).toBeUndefined();
    await app.del('/library/tv:2000');
  });

  it('starts the first search as soon as the episodes arrive', async () => {
    await app.post('/library', { mediaType: 'tv', tmdbId: 2000, add: 'future', seasonOverrides: { 1: 'monitored' } });
    const initial = () => Object.values(app.db.data.jobs).find((job) => job.dedupeKey === 'initial:tv:2000')!;
    // The job waits for its retry after the first try found no episodes. The end of the refresh moves it to now.
    initial().runAt = Date.now() + 15_000;
    await refresh('tv:2000');
    expect(initial().runAt).toBeLessThanOrEqual(Date.now());
    await app.del('/library/tv:2000');
  });

  it('merges refresh jobs for the same title', async () => {
    await app.post('/library/tv:1396/refresh');
    await app.post('/library/tv:1396/refresh');
    expect(Object.values(app.db.data.jobs).filter((job) => job.dedupeKey === 'refresh:tv:1396')).toHaveLength(1);
  });

  it('shows the episodes of one season, with the policy applied', async () => {
    const { body } = await app.get('/library/tv:1396/episodes?season=1');
    // The Future policy starts at the time of the add. Old episodes are not monitored.
    expect(body.episodes.map((e: { number: number; monitored: boolean; aired: boolean }) => [e.number, e.monitored, e.aired])).toEqual([
      [1, false, true],
      [2, false, true],
      [3, true, false],
      [4, true, false],
    ]);
    expect((await app.get('/library/tv:1396/episodes')).status).toBe(400);
  });

  it('shows the queue status of the series and of each episode', async () => {
    const ids = ['tv:1396', 'tv:1396:1x1', 'tv:1396:1x2', 'tv:1396:1x3', 'tv:1396:1x4', 'movie:603'];
    const entry = (id: string, extra: object) => {
      app.db.data.queue[id] = { id, titleKey: id.startsWith('movie:') ? id : 'tv:1396', season: null, number: null, stage: 'queued', branch: null, reason: null, attempt: 1, clearedAt: null, ...extra } as never;
    };
    try {
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'queued', branch: 'waiting' });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'sending' });
      entry('tv:1396:1x3', { season: 1, number: 3, stage: 'fetching' });
      entry('tv:1396:1x4', { season: 1, number: 4, attempt: 0 });
      entry('tv:1396', { stage: 'downloading' });

      const { body } = await app.get('/library/tv:1396/episodes?season=1');
      expect(body.episodes.map((e: { number: number; queue: string | null }) => [e.number, e.queue])).toEqual([
        [1, 'waiting'],
        [2, 'sending'],
        [3, 'fetching'],
        [4, null],
      ]);
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('searching');

      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'downloading' });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'downloading' });
      // Fetching comes before sending and downloading in the page order.
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('fetching');

      entry('tv:1396:1x3', { season: 1, number: 3, stage: 'downloading', clearedAt: NOW });
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('downloading');

      entry('tv:1396', { stage: 'available' });
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'available' });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'available' });
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('available');

      entry('movie:603', { stage: 'searching' });
      expect((await app.get('/library/movie:603')).body.title.queueStatus).toBe('searching');

      // A target that waits for its next search shows why it found nothing.
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } });
      const reasons = (await app.get('/library/tv:1396/episodes?season=1')).body;
      expect(reasons.episodes.map((e: { number: number; queue: string | null }) => [e.number, e.queue])).toEqual([
        [1, 'not_found'],
        [2, 'no_match'],
        [3, null],
        [4, null],
      ]);

      // Every target of the title found nothing.
      entry('tv:1396', { stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } });
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'queued', branch: 'waiting', reason: { code: 'no_results' } });
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('not_found');

      // Every target of the title rejected every release.
      entry('tv:1396', { stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } });
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'queued', branch: 'waiting', reason: { code: 'all_rejected' } });
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('no_match');

      // Every target of the title waits for its next search, which the page shows as searching.
      entry('tv:1396', { stage: 'queued', branch: 'waiting', reason: { code: 'search_deferred' } });
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'queued', branch: 'waiting', reason: { code: 'search_deferred' } });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'queued', branch: 'waiting', reason: { code: 'search_deferred' } });
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('searching');
      const deferred = (await app.get('/library/tv:1396/episodes?season=1')).body;
      expect(deferred.episodes.map((e: { number: number; queue: string | null }) => [e.number, e.queue])).toEqual([
        [1, 'waiting'],
        [2, 'waiting'],
        [3, null],
        [4, null],
      ]);

      // A target that a reason blocks has its own key.
      entry('tv:1396:1x1', { season: 1, number: 1, stage: 'validating', branch: null, reason: { code: 'client_error' } });
      const blocked = (await app.get('/library/tv:1396/episodes?season=1')).body;
      expect(blocked.episodes.map((e: { number: number; queue: string | null }) => [e.number, e.queue])).toEqual([
        [1, 'stuck'],
        [2, 'waiting'],
        [3, null],
        [4, null],
      ]);
      entry('tv:1396', { stage: 'validating', branch: null, reason: { code: 'client_error' } });
      entry('tv:1396:1x2', { season: 1, number: 2, stage: 'validating', branch: null, reason: { code: 'client_error' } });
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBe('stuck');

      for (const id of ids) delete app.db.data.queue[id];
      expect((await app.get('/library/tv:1396')).body.title.queueStatus).toBeNull();
    } finally {
      for (const id of ids) delete app.db.data.queue[id];
    }
  });

  it('keeps the Future policy and the exceptions of the user on a refresh', async () => {
    await app.patch('/library/tv:1396/episodes/1/2', { override: 'monitored' });
    await app.patch('/library/tv:1396/seasons/0', { override: 'monitored' });
    const before = app.db.data.titles['tv:1396']!.futureFrom;
    await refresh('tv:1396');
    const title = app.db.data.titles['tv:1396']!;
    expect(title).toMatchObject({ policy: 'future', futureFrom: before, seasonOverrides: { 0: 'monitored' } });
    expect(title.episodes.find((e) => e.season === 1 && e.number === 2)!.override).toBe('monitored');
    // The episode 1x2 aired and is monitored, so it is missing. The special too.
    expect((await app.get('/library/tv:1396')).body.title).toMatchObject({ availability: 'missing', counts: { eligible: 2, available: 0 } });
  });

  it('keeps the saved episodes when TMDB is down during a refresh', async () => {
    const before = structuredClone(app.db.data.titles['tv:1396']!);
    tmdbDown = true;
    await expect(refresh('tv:1396')).rejects.toMatchObject({ code: 'unavailable', kind: 'outage' });
    tmdbDown = false;
    expect(app.db.data.titles['tv:1396']).toEqual(before);
  });

  it('keeps the policy when the user pauses and resumes', async () => {
    await app.patch('/library/tv:1396', { paused: true });
    expect((await app.get('/library/tv:1396')).body.title).toMatchObject({ paused: true, policy: 'future' });
    const resumed = await app.patch('/library/tv:1396', { paused: false });
    expect(resumed.body.title).toMatchObject({ paused: false, policy: 'future' });
  });

  it('starts the Future boundary when the user chooses that policy', async () => {
    await app.patch('/library/tv:1396', { policy: 'all' });
    const before = Date.now();
    await app.patch('/library/tv:1396', { policy: 'future' });
    expect(app.db.data.titles['tv:1396']!.futureFrom).toBeGreaterThanOrEqual(before);
  });

  it('rejects changes that do not fit the title', async () => {
    expect((await app.patch('/library/movie:603', { policy: 'future' })).status).toBe(400);
    expect((await app.patch('/library/tv:1396', { manualRelease: true })).status).toBe(400);
    expect((await app.patch('/library/tv:1396', { rootId: 'nope' })).status).toBe(400);
    expect((await app.patch('/library/tv:1396', { surprise: 1 })).status).toBe(400);
    expect((await app.get('/library/tv:99999')).status).toBe(404);
    expect((await app.get('/library/not-a-key')).status).toBe(404);
  });

  it('lists, filters, and pages the library', async () => {
    const all = (await app.get('/library')).body;
    expect(all.total).toBe(2);
    expect(all.items.map((i: { title: string }) => i.title)).toEqual(['Breaking Bad', 'The Matrix']);
    expect(all.items).toMatchObject([{ key: 'tv:1396', seriesType: 'anime' }, { key: 'movie:603', seriesType: null }]);
    expect((await app.get('/library?type=movie')).body.items).toHaveLength(1);
    expect((await app.get('/library?type=anime')).body.items.map((i: { key: string }) => i.key)).toEqual(['tv:1396']);
    expect((await app.get('/library?type=tv')).body.items.map((i: { key: string }) => i.key)).toEqual(['tv:1396']);
    app.db.data.titles['tv:1396']!.seriesType = 'standard';
    expect((await app.get('/library?type=anime')).body.items).toHaveLength(0);
    app.db.data.titles['tv:1396']!.seriesType = 'anime';
    expect((await app.get('/library?q=matr')).body.items[0].key).toBe('movie:603');
    expect((await app.get('/library?filter=waiting')).body.total).toBe(0);
    expect((await app.get('/library?limit=1&offset=1')).body).toMatchObject({ total: 2, items: [{ key: 'movie:603' }] });
  });

  it('marks search results that are in the library', async () => {
    // The search route is covered in tmdb.test.ts. This only checks the library mark.
    const search = await app.get('/search?query=tmdb:603&type=movie');
    expect(search.body.results[0]).toMatchObject({ libraryKey: 'movie:603', seriesType: null });
    app.db.data.titles['tv:1396']!.seriesType = 'anime';
    const series = await app.get('/search?query=tmdb:1396&type=tv');
    expect(series.body.results[0]).toMatchObject({ libraryKey: 'tv:1396', seriesType: 'anime' });
  });

  it('blocks the removal of a folder that a title uses', async () => {
    const { roots } = (await app.get('/roots')).body;
    const used = roots.find((r: { id: string }) => r.id === app.db.data.titles['movie:603']!.rootId);
    expect((await app.del(`/roots/${used.id}`)).body).toEqual({ error: 'root_in_use', titles: 1 });
  });

  it('does not move a title that has files to another folder', async () => {
    mkdirSync(join(dir, 'movies2'));
    const other = await app.post('/roots', { path: join(dir, 'movies2'), mediaType: 'movie' });
    app.db.data.titles['movie:603']!.fileId = 'file-1';
    expect((await app.patch('/library/movie:603', { rootId: other.body.id })).body).toEqual({ error: 'files_exist' });
    app.db.data.titles['movie:603']!.fileId = null;
    expect((await app.patch('/library/movie:603', { rootId: other.body.id })).status).toBe(200);
  });

  it('removes a title and leaves the files alone', async () => {
    app.db.data.titles['movie:603']!.fileId = 'file-1';
    expect((await app.del('/library/movie:603')).status).toBe(200);
    expect(app.db.data.titles['movie:603']).toBeUndefined();
  });
});
