import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { emptyData, openDb } from '../../src/core/db.ts';
import { metadataRefreshHandler } from '../../src/jobs/metadata-refresh.ts';
import { queueInitialHandler } from '../../src/jobs/queue-initial.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';
import { MIB, startPipeline, until } from '../helpers/test-pipeline.ts';
import {
  createTmdbFixture,
  FakeWholphin,
  MOVIE_ID,
  OTHER_MOVIE_ID,
  OTHER_SERIES_ID,
  PERSON_ID,
  seedMovie,
  seedSeries,
  SERIES_ID,
} from '../helpers/test-wholphin.ts';

const RELEASE = 'Movie.Name.2019.1080p.BluRay.x264-GRP';
const PACK = 'Show.Name.S01.1080p.WEB-DL.DDP5.1-GRP';

type StartOptions = { tmdb?: boolean };

async function start({ tmdb: withTmdb = true }: StartOptions = {}) {
  const fixture = createTmdbFixture();
  const tmdb = withTmdb ? createTmdb({ apiKey: 'k', fetch: fixture.fetch, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ttlMs: 0 }) : undefined;
  const pipe = await startPipeline({
    handlers: ({ db, events, queue, finder }) => ({
      ...(tmdb ? { 'metadata.refresh': metadataRefreshHandler({ db, tmdb, events }) } : {}),
      'queue.initial': queueInitialHandler({ db, queue, finder }),
    }),
  });
  pipe.db.data.settings.defaultRoots = { movie: 'movie', tv: 'tv' };
  const app = await pipe.api({ tmdb });
  const root = app.base.replace(/\/api$/, '');
  const wholphin = new FakeWholphin(`${root}/seerr/api/v1`, pipe.db.data.apiKey!);
  return { pipe, app, fixture, wholphin };
}

type Rig = Awaited<ReturnType<typeof start>>;
let rig: Rig | undefined;
afterEach(async () => {
  rig?.app.close();
  await rig?.pipe.stop();
  rig = undefined;
});

const resultOf = (body: any, mediaType: string, id: number) => body.results.find((result: any) => result.mediaType === mediaType && result.id === id);

const expectMedia = (body: any, kinds: string[]) => {
  expect(body.results.length, JSON.stringify(body)).toBeGreaterThan(0);
  for (const result of body.results) {
    expect(kinds, JSON.stringify(result)).toContain(result.mediaType);
    expect(result.mediaInfo, JSON.stringify(result)).toBeDefined();
  }
};

describe('the Seerr API for Wholphin', () => {
  it('signs in with the API key', async () => {
    rig = await start();
    const { wholphin } = rig;
    expect(await wholphin.status()).toMatchObject({ version: '3.5.1', commitTag: 'ladarr' });
    expect(await wholphin.settingsPublic()).toMatchObject({ initialized: true, movie4kEnabled: false, series4kEnabled: false, cacheImages: false });
    expect(await wholphin.me()).toMatchObject({ permissions: 786464 });
    // The first three calls of the app are public or keyed in this order.
    expect(wholphin.calls).toEqual(['GET /status', 'GET /settings/public', 'GET /auth/me']);
  });

  it('refuses a missing or wrong key and the password logins', async () => {
    rig = await start();
    const { wholphin } = rig;
    for (const key of [null, 'wrong']) {
      expect(await wholphin.raw('GET', '/auth/me', { apiKey: key })).toMatchObject({ status: 401, body: { status: 401, message: 'Unauthorized' } });
    }
    expect((await wholphin.raw('POST', '/auth/local', { body: { username: 'user', password: 'secret' }, apiKey: null })).status).toBe(501);
    expect((await wholphin.raw('POST', '/auth/jellyfin', { body: { username: 'user', password: 'secret' }, apiKey: null })).status).toBe(501);
  });

  it('searches a page with its language and marks every result', async () => {
    rig = await start();
    const { wholphin, fixture } = rig;
    const body = await wholphin.search('Movie', 2, 'es');
    for (const result of body.results) {
      expect(['movie', 'tv']).toContain(result.mediaType);
      expect(result.mediaInfo).toBeDefined();
    }
    const call = fixture.calls.find((url) => url.pathname === '/3/search/multi')!;
    expect(call.searchParams.get('query')).toBe('Movie');
    expect(call.searchParams.get('page')).toBe('2');
    expect(call.searchParams.get('language')).toBe('es');
    expect(resultOf(body, 'movie', MOVIE_ID)).toMatchObject({
      mediaType: 'movie',
      posterPath: '/movie.jpg',
      backdropPath: '/movie-backdrop.jpg',
      releaseDate: '2019-03-01',
      voteAverage: 8,
      genreIds: [28],
      originalLanguage: 'en',
      mediaInfo: { id: MOVIE_ID, tmdbId: MOVIE_ID, status: 1 },
    });
    expect(resultOf(body, 'tv', SERIES_ID)).toMatchObject({
      mediaType: 'tv',
      posterPath: '/show.jpg',
      firstAirDate: '2020-01-01',
      name: 'Show Name',
      mediaInfo: { tmdbId: SERIES_ID, status: 1 },
    });
  });

  it('answers the discover rows and maps their filters', async () => {
    rig = await start();
    const { wholphin, fixture } = rig;

    const movies = await wholphin.discoverMovies({ page: 2, language: 'es', genre: '28', sortBy: 'popularity.desc' });
    expectMedia(movies, ['movie']);
    const movieCall = fixture.calls.filter((url) => url.pathname === '/3/discover/movie').at(-1)!;
    expect(movieCall.searchParams.get('page')).toBe('2');
    expect(movieCall.searchParams.get('language')).toBe('es');
    expect(movieCall.searchParams.get('with_genres')).toBe('28');
    expect(movieCall.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(movieCall.searchParams.get('include_adult')).toBe('false');

    const tv = await wholphin.discoverTv({ network: '213' });
    expectMedia(tv, ['tv']);
    expect(fixture.calls.filter((url) => url.pathname === '/3/discover/tv').at(-1)!.searchParams.get('with_networks')).toBe('213');

    expectMedia(await wholphin.trending(1, 'en'), ['movie', 'tv']);

    expectMedia(await wholphin.upcomingMovies(), ['movie']);
    expect(fixture.calls.find((url) => url.pathname === '/3/discover/movie' && url.searchParams.get('primary_release_date.gte'))!.searchParams.get('primary_release_date.gte')).toMatch(/^\d{4}-\d{2}-\d{2}$/);

    expectMedia(await wholphin.upcomingTv(), ['tv']);
    expect(fixture.calls.find((url) => url.pathname === '/3/discover/tv' && url.searchParams.get('first_air_date.gte'))!.searchParams.get('first_air_date.gte')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(wholphin.calls).toEqual(['GET /discover/movies', 'GET /discover/tv', 'GET /discover/trending', 'GET /discover/movies/upcoming', 'GET /discover/tv/upcoming']);
    for (const result of movies.results) expect(result).toMatchObject({ posterPath: expect.any(String), releaseDate: expect.any(String) });
    for (const result of tv.results) expect(result).toMatchObject({ posterPath: expect.any(String), firstAirDate: expect.any(String) });
  });

  it('answers the genre sliders with no backdrops', async () => {
    rig = await start();
    const { wholphin, fixture } = rig;
    expect(await wholphin.genreSlider('movie', 'es')).toMatchObject([{ id: 28, name: 'Action', backdrops: [] }]);
    expect(await wholphin.genreSlider('tv', 'es')).toMatchObject([{ id: 18, name: 'Drama', backdrops: [] }]);
    expect(fixture.calls.find((url) => url.pathname === '/3/genre/movie/list')!.searchParams.get('language')).toBe('es');
    expect(fixture.calls.find((url) => url.pathname === '/3/genre/tv/list')!.searchParams.get('language')).toBe('es');
  });

  it('answers movie details, ratings, similar, and recommendations', async () => {
    rig = await start();
    const { wholphin } = rig;
    const details = await wholphin.movie(MOVIE_ID, 'es');
    expect(details).toMatchObject({ id: MOVIE_ID, title: 'Movie Name', credits: { cast: expect.any(Array) }, mediaInfo: { id: MOVIE_ID, tmdbId: MOVIE_ID, status: 1, jellyfinMediaId: null } });
    expect(details.credits.cast.length).toBeGreaterThan(0);
    expect(await wholphin.movieRatings(MOVIE_ID)).toEqual({});

    const similar = await wholphin.movieSimilar(MOVIE_ID, 1, 'es');
    for (const result of similar.results) expect(result).toMatchObject({ mediaType: 'movie', mediaInfo: { tmdbId: OTHER_MOVIE_ID } });
    const recommendations = await wholphin.movieRecommendations(MOVIE_ID, 1, 'es');
    for (const result of recommendations.results) expect(result).toMatchObject({ mediaType: 'movie', mediaInfo: { tmdbId: OTHER_MOVIE_ID } });

    expect(details).toMatchObject({
      posterPath: '/movie.jpg',
      backdropPath: '/movie-backdrop.jpg',
      releaseDate: '2019-03-01',
      runtime: 100,
      voteAverage: 8,
      voteCount: 100,
      imdbId: 'tt0133093',
      originalTitle: 'Movie Name',
      externalIds: { imdbId: 'tt0133093' },
      credits: { cast: expect.arrayContaining([expect.objectContaining({ profilePath: '/person.jpg', character: 'Lead' })]) },
      relatedVideos: expect.arrayContaining([expect.objectContaining({ key: 'trailer', url: 'https://www.youtube.com/watch?v=trailer', type: 'Trailer' })]),
    });
    for (const result of similar.results) expect(result).toMatchObject({ posterPath: '/other-movie.jpg', releaseDate: '2020-05-01' });
    for (const result of recommendations.results) expect(result).toMatchObject({ posterPath: '/other-movie.jpg', releaseDate: '2020-05-01' });
  });

  it('answers series details, ratings, similar, and recommendations', async () => {
    rig = await start();
    const { wholphin } = rig;
    const details = await wholphin.tv(SERIES_ID, 'es');
    expect(details).toMatchObject({ id: SERIES_ID, name: 'Show Name', credits: { cast: expect.any(Array) }, mediaInfo: { id: SERIES_ID, tmdbId: SERIES_ID, status: 1, jellyfinMediaId: null } });
    expect(details.mediaInfo.seasons).toEqual(expect.arrayContaining([expect.objectContaining({ seasonNumber: 1 }), expect.objectContaining({ seasonNumber: 2 })]));
    expect(await wholphin.tvRatings(SERIES_ID)).toEqual({});

    const similar = await wholphin.tvSimilar(SERIES_ID, 1, 'es');
    for (const result of similar.results) expect(result).toMatchObject({ mediaType: 'tv', mediaInfo: { tmdbId: OTHER_SERIES_ID } });
    const recommendations = await wholphin.tvRecommendations(SERIES_ID, 1, 'es');
    for (const result of recommendations.results) expect(result).toMatchObject({ mediaType: 'tv', mediaInfo: { tmdbId: OTHER_SERIES_ID } });

    expect(details).toMatchObject({
      posterPath: '/show.jpg',
      backdropPath: '/show-backdrop.jpg',
      firstAirDate: '2020-01-01',
      voteAverage: 8,
      externalIds: { tvdbid: 81189 },
      seasons: expect.arrayContaining([expect.objectContaining({ seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' })]),
      credits: { cast: expect.arrayContaining([expect.objectContaining({ profilePath: '/person.jpg' })]) },
      relatedVideos: expect.arrayContaining([expect.objectContaining({ key: 'trailer', type: 'Trailer' })]),
    });
    for (const result of similar.results) expect(result).toMatchObject({ posterPath: '/other-show.jpg', firstAirDate: '2021-01-01' });
    for (const result of recommendations.results) expect(result).toMatchObject({ posterPath: '/other-show.jpg', firstAirDate: '2021-01-01' });
  });

  it('marks every person credit', async () => {
    rig = await start();
    const credits = await rig.wholphin.personCredits(PERSON_ID, 'en');
    expect(credits).toMatchObject({ id: PERSON_ID });
    expect(credits.cast.length).toBeGreaterThan(0);
    expect(credits.crew.length).toBeGreaterThan(0);
    for (const item of [...credits.cast, ...credits.crew]) expect(item.mediaInfo, JSON.stringify(item)).toBeDefined();
    for (const item of [...credits.cast, ...credits.crew]) {
      expect(item).toMatchObject({ mediaType: expect.any(String), posterPath: expect.any(String), profilePath: '/person.jpg' });
    }
  });

  it('shows the target state in search, discover, details, and person credits', async () => {
    rig = await start();
    const { pipe, wholphin } = rig;
    // The TV show has one file of three episodes, the movie has a file, and the second show has none.
    seedSeries(pipe.db, { tmdbId: SERIES_ID, files: [[1, 1]] });
    seedMovie(pipe.db, { tmdbId: OTHER_MOVIE_ID, file: true });
    seedSeries(pipe.db, { tmdbId: OTHER_SERIES_ID });
    const created = await wholphin.raw('POST', '/request', { body: { mediaType: 'movie', mediaId: MOVIE_ID } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 2 });

    const search = await wholphin.search('Name', 1, 'en');
    expect(resultOf(search, 'movie', MOVIE_ID).mediaInfo).toMatchObject({ status: 3 });
    expect(resultOf(search, 'movie', MOVIE_ID).mediaInfo.requests).toMatchObject([{ id: created.body.id, status: 2 }]);
    expect(resultOf(search, 'movie', OTHER_MOVIE_ID).mediaInfo).toMatchObject({ status: 5 });
    expect(resultOf(search, 'tv', SERIES_ID).mediaInfo).toMatchObject({ status: 4 });
    expect(resultOf(search, 'tv', OTHER_SERIES_ID).mediaInfo).toMatchObject({ status: 3 });

    const movies = await wholphin.discoverMovies();
    expect(resultOf(movies, 'movie', MOVIE_ID).mediaInfo).toMatchObject({ status: 3, requests: [expect.objectContaining({ id: created.body.id })] });
    expect(resultOf(movies, 'movie', OTHER_MOVIE_ID).mediaInfo).toMatchObject({ status: 5 });
    const tv = await wholphin.discoverTv();
    expect(resultOf(tv, 'tv', SERIES_ID).mediaInfo).toMatchObject({ status: 4 });
    expect(resultOf(tv, 'tv', OTHER_SERIES_ID).mediaInfo).toMatchObject({ status: 3 });

    const requested = await wholphin.movie(MOVIE_ID);
    expect(requested.mediaInfo).toMatchObject({ status: 3, requests: [expect.objectContaining({ id: created.body.id, status: 2 })] });
    const complete = await wholphin.movie(OTHER_MOVIE_ID);
    expect(complete.mediaInfo).toMatchObject({ status: 5 });
    const series = await wholphin.tv(SERIES_ID);
    expect(series.mediaInfo).toMatchObject({ status: 4 });
    expect(series.mediaInfo.seasons.find((season: any) => season.seasonNumber === 1)).toMatchObject({ status: 4 });

    const credits = await wholphin.personCredits(PERSON_ID);
    const creditOf = (id: number, mediaType: string) => [...credits.cast, ...credits.crew].find((item: any) => item.id === id && (item.mediaType ?? item.media_type) === mediaType);
    expect(creditOf(MOVIE_ID, 'movie').mediaInfo).toMatchObject({ status: 3, requests: [expect.objectContaining({ id: created.body.id })] });
    expect(creditOf(OTHER_MOVIE_ID, 'movie').mediaInfo).toMatchObject({ status: 5 });
    expect(creditOf(SERIES_ID, 'tv').mediaInfo).toMatchObject({ status: 4 });
    expect(creditOf(OTHER_SERIES_ID, 'tv').mediaInfo).toMatchObject({ status: 3 });
  });

  it('adds a requested movie and shows each step', async () => {
    rig = await start();
    const { pipe, wholphin } = rig;
    pipe.tracker.state.items = [{ title: RELEASE, size: 100 * 120 * MIB }];

    const created = await wholphin.raw('POST', '/request', { body: { mediaType: 'movie', mediaId: MOVIE_ID } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 2 });
    expect(pipe.db.data.titles['movie:603']).toMatchObject({ rootId: 'movie', preset: 'p1080', paused: false });
    await until(() => pipe.db.data.queue['movie:603']?.stage === 'downloading');

    const listed = await wholphin.requests();
    expect(listed.results).toMatchObject([{ id: created.body.id, status: 2, media: { tmdbId: MOVIE_ID } }]);

    const processing = await wholphin.movie(MOVIE_ID);
    expect(processing.mediaInfo).toMatchObject({ status: 3, requests: [expect.objectContaining({ id: created.body.id, status: 2 })] });

    pipe.complete(RELEASE, { [`${RELEASE}.mkv`]: 'video-data' });
    await until(() => pipe.db.data.queue['movie:603']?.stage === 'available');

    const done = await wholphin.movie(MOVIE_ID);
    expect(done.mediaInfo).toMatchObject({ status: 5, requests: [expect.objectContaining({ id: created.body.id, status: 5 })] });
    const after = await wholphin.requests();
    expect(after.results).toMatchObject([{ id: created.body.id, status: 5, media: { tmdbId: MOVIE_ID, status: 5 } }]);
  }, 20_000);

  it('adds only the requested season of a series', async () => {
    rig = await start();
    const { pipe, wholphin } = rig;
    pipe.tracker.state.items = [{ title: PACK, size: 2 * 60 * 45 * MIB }];

    const created = await wholphin.raw('POST', '/request', { body: { mediaType: 'tv', mediaId: SERIES_ID, seasons: [1] } });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ status: 2 });
    await until(() => pipe.db.data.titles['tv:1396']?.seasonOverrides['2'] === 'unmonitored');
    expect(pipe.db.data.titles['tv:1396']!.seasonOverrides).toEqual({ 1: 'monitored', 2: 'unmonitored' });
    const listed = await wholphin.requests();
    expect(listed.results).toMatchObject([{ media: { tmdbId: SERIES_ID } }]);
    expect(listed.results[0].media.seasons).toEqual(expect.any(Array));

    await until(() => ['tv:1396:1x1', 'tv:1396:1x2'].every((id) => pipe.db.data.queue[id]?.stage === 'downloading'), 12_000);
    const processing = await wholphin.tv(SERIES_ID);
    expect(processing.mediaInfo.seasons.find((season: any) => season.seasonNumber === 1)).toMatchObject({ status: 3 });
    expect(processing.mediaInfo.seasons.find((season: any) => season.seasonNumber === 2)).toMatchObject({ status: 1 });
    expect(processing.mediaInfo.requests[0].seasons).toMatchObject([{ seasonNumber: 1, status: 2 }]);

    pipe.complete(PACK, { 'Show.Name.S01E01.mkv': 'one', 'Show.Name.S01E02.mkv': 'two' });
    await until(() => ['tv:1396:1x1', 'tv:1396:1x2'].every((id) => pipe.db.data.queue[id]?.stage === 'available'));

    const done = await wholphin.tv(SERIES_ID);
    expect(done.mediaInfo).toMatchObject({ status: 5 });
    expect(done.mediaInfo.seasons.find((season: any) => season.seasonNumber === 1)).toMatchObject({ status: 5 });
    expect(done.mediaInfo.requests[0].seasons).toMatchObject([{ seasonNumber: 1, status: 5 }]);
    expect(processing).toMatchObject({ seasons: expect.arrayContaining([expect.objectContaining({ seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' })]) });
    expect(processing.seasons[0]).not.toHaveProperty('season_number');
    expect(processing.seasons[0]).not.toHaveProperty('episode_count');
  }, 25_000);

  it('answers a duplicate request with the same record', async () => {
    rig = await start();
    const { wholphin } = rig;
    const body = { mediaType: 'movie', mediaId: MOVIE_ID };
    const first = await wholphin.raw('POST', '/request', { body });
    const second = await wholphin.raw('POST', '/request', { body });
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(second.body).toMatchObject({ id: first.body.id, status: 2 });
    const listed = await wholphin.requests();
    expect(listed.results.filter((request: any) => request.id === first.body.id)).toHaveLength(1);
    expect(listed.results).toHaveLength(1);
  });

  it('refuses a request with no media type, 4K, or no root', async () => {
    rig = await start();
    const { pipe, wholphin } = rig;
    for (const body of [{ mediaId: MOVIE_ID }, { mediaType: 'book', mediaId: MOVIE_ID }, { mediaType: 'movie', mediaId: MOVIE_ID, is4k: true }]) {
      expect((await wholphin.raw('POST', '/request', { body })).status, JSON.stringify(body)).toBe(400);
    }
    delete pipe.db.data.roots.movie;
    pipe.db.data.settings.defaultRoots.movie = null;
    expect((await wholphin.raw('POST', '/request', { body: { mediaType: 'movie', mediaId: MOVIE_ID } })).status).toBe(400);
    expect(pipe.db.data.titles).toEqual({});
  });

  it('does not update or delete a request', async () => {
    rig = await start();
    const { wholphin } = rig;
    expect((await wholphin.raw('PUT', '/request/1', { body: { seasons: [1] } })).status).toBe(501);
    expect((await wholphin.raw('DELETE', '/request/1')).status).toBe(501);
  });

  it('answers 503 when the TMDB key is missing', async () => {
    rig = await start({ tmdb: false });
    expect((await rig.wholphin.raw('GET', '/search', { params: { query: 'x' } })).status).toBe(503);
    expect((await rig.wholphin.raw('GET', '/movie/603')).status).toBe(503);
  });

  it('answers 503 when TMDB is down', async () => {
    rig = await start();
    rig.fixture.state.outage = true;
    expect((await rig.wholphin.raw('GET', '/search', { params: { query: 'x' } })).status).toBe(503);
    expect((await rig.wholphin.raw('GET', '/movie/603')).status).toBe(503);
  });

  it('answers 404 for an unknown path', async () => {
    rig = await start();
    expect((await rig.wholphin.raw('GET', '/unknown')).status).toBe(404);
  });

  it('answers under the URL base', async () => {
    const db = await openDb('unused.json');
    db.data.apiKey = 'secret';
    const server = createApp(db, { urlBase: '/base' }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/base/seerr/api/v1`;
    try {
      expect(await (await fetch(`${base}/status`)).json()).toMatchObject({ version: '3.5.1', commitTag: 'ladarr' });
      const me = await fetch(`${base}/auth/me`, { headers: { 'x-api-key': 'secret' } });
      expect(me.status).toBe(200);
      expect(await me.json()).toMatchObject({ permissions: 786464 });
    } finally {
      server.closeAllConnections();
      server.close();
    }
  });
});

it('starts with an empty seerr section', () => {
  expect(emptyData().seerr).toEqual({ requestSeq: 0, requests: {} });
});

it('loads an old database file with no seerr section', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ladarr-seerr-db-'));
  const file = join(dir, 'db.json');
  try {
    const old: Record<string, unknown> = { ...emptyData() };
    delete old.seerr;
    writeFileSync(file, JSON.stringify(old));
    vi.stubEnv('NODE_ENV', 'production');
    const db = await openDb(file);
    expect(db.data.seerr).toEqual({ requestSeq: 0, requests: {} });
  } finally {
    vi.unstubAllEnvs();
    rmSync(dir, { recursive: true, force: true });
  }
});
