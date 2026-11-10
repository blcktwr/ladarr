import { mkdtempSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { open } from '../../src/core/db.ts';
import { closeLog, logToFile, recentLogs } from '../../src/core/log.ts';
import { createTmdb, TmdbError } from '../../src/metadata/tmdb.ts';

const KEY = 'secret-key-1234';
const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });

// The fake answers by path, like TMDB. It records every URL it gets.
function fakeTmdb(routes: Record<string, (url: URL) => Response | Promise<Response>>) {
  const calls: URL[] = [];
  const send = vi.fn(async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    const route = routes[url.pathname.replace('/3', '')];
    return route ? route(url) : json({ status_code: 34 }, 404);
  }) as unknown as typeof fetch;
  return { send, calls };
}

const client = (send: typeof fetch, extra: Partial<Parameters<typeof createTmdb>[0]> = {}) =>
  createTmdb({ apiKey: KEY, fetch: send, baseUrl: 'https://tmdb.test/3', spacingMs: 0, ...extra });

const movie = {
  id: 603,
  title: 'The Matrix',
  original_title: 'The Matrix',
  original_language: 'en',
  overview: 'A hacker learns the truth.',
  release_date: '1999-03-31',
  status: 'Released',
  runtime: 136,
  vote_average: 8.2,
  vote_count: 25000,
  poster_path: '/poster.jpg',
  backdrop_path: null,
  imdb_id: 'tt0133093',
  alternative_titles: { titles: [{ iso_3166_1: 'MX', title: 'Matrix' }, { iso_3166_1: 'US', title: 'The Matrix' }] },
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
  release_dates: {
    results: [
      {
        iso_3166_1: 'US',
        release_dates: [
          { type: 3, release_date: '1999-03-31T00:00:00.000Z' },
          { type: 4, release_date: '2020-07-15T00:00:00.000Z' },
          { type: 5, release_date: '' },
          { type: 9, release_date: '2021-01-01T00:00:00.000Z' },
        ],
      },
    ],
  },
};

const series = {
  id: 1396,
  name: 'Breaking Bad',
  original_name: 'Breaking Bad',
  original_language: 'en',
  first_air_date: '2008-01-20',
  status: 'Ended',
  episode_run_time: [],
  last_episode_to_air: { runtime: 59 },
  vote_average: 0,
  vote_count: 0,
  external_ids: { imdb_id: 'tt0903747', tvdb_id: 81189 },
  alternative_titles: { results: [{ title: 'Braking Bad' }] },
  seasons: [
    { season_number: 0, episode_count: 11, air_date: null },
    { season_number: 1, episode_count: 7, air_date: '2008-01-20' },
  ],
};

describe('tmdb client', () => {
  it('sends the key in the query and keeps it out of error messages', async () => {
    const { send, calls } = fakeTmdb({ '/movie/1': () => json({}, 500) });
    const error = await client(send).details('movie', 1).catch((e) => e);
    expect(calls[0]!.searchParams.get('api_key')).toBe(KEY);
    expect(error).toBeInstanceOf(TmdbError);
    expect(error.message).not.toContain(KEY);
  });

  it('shares one request between equal calls that run together, then serves the cache', async () => {
    const { send } = fakeTmdb({ '/search/multi': () => json({ results: [] }) });
    const tmdb = client(send);
    await Promise.all([tmdb.search('matrix'), tmdb.search('matrix'), tmdb.search('matrix')]);
    await tmdb.search('matrix');
    expect(send).toHaveBeenCalledTimes(1);
    await tmdb.search('other');
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('keeps only movies and series from a search', async () => {
    const { send } = fakeTmdb({
      '/search/multi': () =>
        json({
          results: [
            { media_type: 'person', id: 1, name: 'Someone' },
            { media_type: 'movie', id: 603, title: 'The Matrix', release_date: '1999-03-31', poster_path: '/p.jpg', original_language: 'en' },
            { media_type: 'tv', id: 603, name: 'Same number', first_air_date: '' },
          ],
        }),
    });
    const results = await client(send).search('x');
    expect(results.map((r) => [r.mediaType, r.tmdbId, r.year])).toEqual([['movie', 603, 1999], ['tv', 603, null]]);
  });

  it('reads a movie with regional release dates and drops unknown types and empty dates', async () => {
    const { send } = fakeTmdb({ '/movie/603': () => json(movie) });
    const meta = await client(send).details('movie', 603);
    expect(meta).toMatchObject({ mediaType: 'movie', title: 'The Matrix', year: 1999, runtime: 136, rating: 8.2, imdbId: 'tt0133093', tvdbId: null, aliases: ['Matrix'] });
    expect(meta.releaseDates).toEqual([
      { region: 'US', kind: 'theatrical', date: '1999-03-31T00:00:00.000Z' },
      { region: 'US', kind: 'digital', date: '2020-07-15T00:00:00.000Z' },
    ]);
  });

  it('keeps the regions of each alias, and dedupes the regions of the same title', async () => {
    const { send } = fakeTmdb({
      '/movie/603': () =>
        json({
          ...movie,
          alternative_titles: {
            titles: [
              { iso_3166_1: 'MX', title: 'Matrix' },
              { iso_3166_1: 'ES', title: 'Matrix' },
              { iso_3166_1: 'US', title: 'The Matrix' },
            ],
          },
        }),
    });
    const meta = await client(send).details('movie', 603);
    expect(meta.aliases).toEqual(['Matrix']);
    expect(meta.aliasRegions).toEqual({ Matrix: ['MX', 'ES'], 'The Matrix': ['US'] });
  });

  it('reads a series, keeps the TVDB ID apart, and treats a zero rating or runtime as unknown', async () => {
    const { send } = fakeTmdb({ '/tv/1396': () => json(series) });
    const meta = await client(send).details('tv', 1396);
    expect(meta).toMatchObject({ mediaType: 'tv', tmdbId: 1396, tvdbId: 81189, rating: null, runtime: 59, aliases: ['Braking Bad'] });
    expect(meta.seasons).toEqual([
      { seasonNumber: 0, episodeCount: 11, airDate: null },
      { seasonNumber: 1, episodeCount: 7, airDate: '2008-01-20' },
    ]);
  });

  it('reads the episodes of a season and keeps a date-only air date as a date', async () => {
    const { send } = fakeTmdb({
      '/tv/1396/season/1': () =>
        json({ episodes: [{ id: 62085, episode_number: 1, name: 'Pilot', air_date: '2008-01-20', runtime: 58 }, { id: 62086, episode_number: 2, name: 'TBA', air_date: null, runtime: 0 }, { name: 'broken' }] }),
    });
    const episodes = await client(send).season(1396, 1);
    expect(episodes).toEqual([
      { tmdbId: 62085, season: 1, number: 1, name: 'Pilot', airDate: '2008-01-20', runtime: 58 },
      { tmdbId: 62086, season: 1, number: 2, name: 'TBA', airDate: null, runtime: null },
    ]);
  });

  it('reads the first 12 actors and skips an entry with no ID', async () => {
    const people = Array.from({ length: 14 }, (_, i) => ({ id: i + 1, name: `Actor ${i + 1}`, character: `Role ${i + 1}`, profile_path: i === 0 ? '/a.jpg' : null }));
    const { send } = fakeTmdb({ '/movie/603/credits': () => json({ cast: [{ name: 'broken' }, ...people] }) });
    const cast = await client(send).cast('movie', 603);
    expect(cast).toHaveLength(12);
    expect(cast[0]).toEqual({ id: 1, name: 'Actor 1', character: 'Role 1', profilePath: '/a.jpg' });
    expect(cast[1]!.profilePath).toBeNull();
  });

  it('reads the recommendations as results of the same media type', async () => {
    const { send } = fakeTmdb({ '/tv/1396/recommendations': () => json({ results: [{ id: 60059, name: 'Better Call Saul', first_air_date: '2015-02-08', poster_path: '/s.jpg', overview: 'x', original_language: 'en' }] }) });
    expect(await client(send).recommendations('tv', 1396)).toEqual([
      { mediaType: 'tv', tmdbId: 60059, title: 'Better Call Saul', year: 2015, overview: 'x', posterPath: '/s.jpg', originalLanguage: 'en' },
    ]);
  });

  it('reads an actor with each movie and series once, the newest first', async () => {
    const { send } = fakeTmdb({
      '/person/6384': () =>
        json({
          id: 6384,
          name: 'Keanu Reeves',
          profile_path: '/k.jpg',
          also_known_as: ['Keanu Charles Reeves', '', 7, 'キアヌ・リーブス'],
          popularity: 28.5,
          combined_credits: {
            cast: [
              { id: 603, media_type: 'movie', title: 'The Matrix', release_date: '1999-03-31' },
              { id: 1, media_type: 'tv', name: 'Talk Show', first_air_date: '2020-05-01' },
              { id: 603, media_type: 'movie', title: 'The Matrix', release_date: '1999-03-31' },
              { id: 9, media_type: 'movie', title: 'No Date', release_date: '' },
              { id: 7, media_type: 'person', name: 'Someone' },
              { id: 604, media_type: 'movie', title: 'The Matrix Reloaded', release_date: '2003-05-15' },
            ],
          },
        }),
    });
    const { person, credits } = await client(send).person(6384);
    expect(person).toEqual({ id: 6384, name: 'Keanu Reeves', profilePath: '/k.jpg', alsoKnownAs: ['Keanu Charles Reeves', 'キアヌ・リーブス'], popularity: 28.5 });
    expect(credits.map((credit) => `${credit.mediaType}:${credit.tmdbId}`)).toEqual(['tv:1', 'movie:604', 'movie:603', 'movie:9']);
  });

  it('maps each failure to a code and a job error kind', async () => {
    const status = (code: number, headers?: Record<string, string>) => client(fakeTmdb({ '/movie/1': () => json({}, code, headers) }).send).details('movie', 1).catch((e) => e);
    expect(await status(404)).toMatchObject({ code: 'not_found', kind: 'invalid_input' });
    expect(await status(401)).toMatchObject({ code: 'invalid_key', kind: 'outage' });
    expect(await status(429, { 'retry-after': '1' })).toMatchObject({ code: 'rate_limited', kind: 'outage' });
    expect(await status(503)).toMatchObject({ code: 'unavailable', kind: 'outage' });
  });

  it('gives up on a request that takes too long', async () => {
    const hang = ((_url: unknown, init: RequestInit) =>
      new Promise((_, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as unknown as typeof fetch;
    const error = await client(hang, { timeoutMs: 20 }).details('movie', 1).catch((e) => e);
    expect(error).toMatchObject({ code: 'unavailable' });
  });

  it('serves the old answer while TMDB is down, but not after a 404', async () => {
    let down = false;
    const { send } = fakeTmdb({ '/movie/603': () => (down ? json({}, 503) : json(movie)) });
    const tmdb = client(send, { ttlMs: 5 });
    await tmdb.details('movie', 603);
    down = true;
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await tmdb.details('movie', 603)).title).toBe('The Matrix');
    // A call for fresh data sees the failure.
    expect(await tmdb.details('movie', 603, 0).catch((e) => e.code)).toBe('unavailable');
    expect(tmdb.status()).toMatchObject({ ok: false, code: 'unavailable' });
    expect(await tmdb.details('movie', 1).catch((e) => e.code)).toBe('not_found');
  });

  it('starts requests at least spacingMs apart', async () => {
    const starts: number[] = [];
    const send = (async () => {
      starts.push(Date.now());
      return json({ results: [] });
    }) as unknown as typeof fetch;
    const tmdb = client(send, { spacingMs: 30 });
    await Promise.all(['a', 'b', 'c'].map((query) => tmdb.search(query)));
    // A timer can fire late under load, so the check is on the span from the first start.
    expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(25);
    expect(starts[2]! - starts[0]!).toBeGreaterThanOrEqual(55);
  });

  it('follows the last request for its health', async () => {
    let key = 'bad';
    const { send } = fakeTmdb({ '/configuration': () => (key === 'bad' ? json({}, 401) : json({ images: {} })) });
    const tmdb = client(send);
    expect(tmdb.status().ok).toBeNull();
    expect(await tmdb.check()).toMatchObject({ ok: false, code: 'invalid_key' });
    key = 'good';
    expect(await tmdb.check()).toMatchObject({ ok: true });
  });

  it('logs the outbound request with the query and the key hidden', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'ladarr-tmdb-'));
    try {
      logToFile(join(dir, 'ladarr.log'));
      const { send } = fakeTmdb({ '/search/multi': () => json({ results: [] }), '/search/movie': () => json({ results: [] }) });
      await client(send).search('The Matrix');
      await closeLog();
      const entries = await recentLogs(10, { kind: 'requests' });
      const entry = entries.find((item) => item.message === 'outbound request');
      expect(entry).toMatchObject({
        system: 'TMDB',
        request: { method: 'GET', url: expect.stringMatching(/\/search\/(movie|multi)\?/) },
        response: { status: 200 },
      });
      expect((entry!.request as { url: string }).url).toContain('api_key=[redacted]');
      expect(JSON.stringify(entries)).not.toContain(KEY);
    } finally {
      await closeLog();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('search route', () => {
  let base = '';
  let close: () => void;
  let cookie = '';
  const { send } = fakeTmdb({
    '/search/multi': (url) => {
      const query = url.searchParams.get('query');
      if (query === 'boom') return json({ results: [] });
      // Scrambled on purpose, and one title has no date.
      if (query === 'many') {
        return json({ results: [
          { media_type: 'movie', id: 2, title: 'New', release_date: '2024-05-01' },
          { media_type: 'tv', id: 3, name: 'Old', first_air_date: '1980-01-01' },
          { media_type: 'movie', id: 4, title: 'Undated' },
        ] });
      }
      return json({ results: [{ media_type: 'movie', id: 603, title: 'The Matrix', release_date: '1999-03-31' }] });
    },
    '/movie/603': () => json(movie),
    '/find/81189': () => json({ tv_results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20' }] }),
    '/find/5': () => json({ tv_results: [{ id: 1, name: 'A' }, { id: 2, name: 'B' }] }),
    '/find/6': () => json({ tv_results: [] }),
  });

  beforeAll(async () => {
    const db = await open('unused.json');
    const server = createApp({ tmdb: client(send) }).listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    close = () => server.close();
    const res = await fetch(`${base}/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
    cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  });
  afterAll(() => close());

  const search = async (query: string, type?: string) => {
    const res = await fetch(`${base}/search?query=${encodeURIComponent(query)}${type ? `&type=${type}` : ''}`, { headers: { cookie } });
    return { status: res.status, body: await res.json() };
  };

  it('requires a session', async () => {
    expect((await fetch(`${base}/search?query=x`)).status).toBe(401);
  });

  it('searches by name', async () => {
    const { status, body } = await search('matrix');
    expect(status).toBe(200);
    expect(body.results).toMatchObject([{ mediaType: 'movie', tmdbId: 603, year: 1999 }]);
  });

  it('shows the oldest title first, and a title with no year last', async () => {
    const { body } = await search('many');
    expect(body.results.map((result: { title: string; year: number | null }) => [result.title, result.year])).toEqual([
      ['Old', 1980],
      ['New', 2024],
      ['Undated', null],
    ]);
  });

  it('rejects an empty query', async () => {
    expect((await search('  ')).status).toBe(400);
  });

  it('looks up tmdb:<id> only with a media type', async () => {
    expect((await search('tmdb:603')).body).toEqual({ error: 'media_type_required' });
    expect((await search('tmdb:603', 'movie')).body.results).toMatchObject([{ tmdbId: 603, mediaType: 'movie' }]);
    expect((await search('tmdb:604', 'movie')).body).toEqual({ results: [] });
  });

  it('asks for a match unless exactly one series has the TVDB ID', async () => {
    expect((await search('tvdb:81189')).body).toMatchObject({ needsMatch: false, results: [{ tmdbId: 1396 }] });
    expect((await search('tvdb:5')).body).toMatchObject({ needsMatch: true });
    expect((await search('tvdb:6')).body).toEqual({ results: [], needsMatch: true });
  });
});

describe('without a TMDB client', () => {
  it('reports the missing provider and refuses to search', async () => {
    const db = await open('unused.json');
    const server = createApp().listen(0);
    await new Promise((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
    try {
      const res = await fetch(`${base}/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
      const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
      expect((await fetch(`${base}/search?query=x`, { headers: { cookie } })).status).toBe(503);
      const status = await (await fetch(`${base}/system/status`, { headers: { cookie } })).json();
      expect(status.problems.map((p: { id: string }) => p.id)).toContain('metadata_missing');
    } finally {
      server.close();
    }
  });
});

describe('tmdb raw methods', () => {
  it('searches a page and passes its language', async () => {
    const { send, calls } = fakeTmdb({
      '/search/multi': () => json({ page: 2, total_pages: 5, total_results: 80, results: [{ id: 603, media_type: 'movie', title: 'The Matrix' }] }),
    });
    const page = await client(send).searchPage('matrix', 2, 'es');
    expect(page).toMatchObject({ page: 2, total_pages: 5, total_results: 80, results: [{ id: 603 }] });
    expect(JSON.stringify(page)).not.toContain(KEY);
    expect(calls[0]!.searchParams.get('query')).toBe('matrix');
    expect(calls[0]!.searchParams.get('page')).toBe('2');
    expect(calls[0]!.searchParams.get('language')).toBe('es');
  });

  it('discovers movies and series with the TMDB names', async () => {
    const { send, calls } = fakeTmdb({
      '/discover/movie': () => json({ page: 1, total_pages: 1, total_results: 0, results: [] }),
      '/discover/tv': () => json({ page: 1, total_pages: 1, total_results: 0, results: [] }),
    });
    const tmdb = client(send);
    await tmdb.discover('movie', { page: '1', language: 'es', with_genres: '28', sort_by: 'popularity.desc', include_adult: 'false' });
    await tmdb.discover('tv', { page: '2', with_networks: '213' });
    expect(calls.map((url) => url.pathname)).toEqual(['/3/discover/movie', '/3/discover/tv']);
    expect(calls[0]!.searchParams.get('with_genres')).toBe('28');
    expect(calls[0]!.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(calls[0]!.searchParams.get('include_adult')).toBe('false');
    expect(calls[1]!.searchParams.get('page')).toBe('2');
    expect(calls[1]!.searchParams.get('with_networks')).toBe('213');
  });

  it('reads trending and details with the appended parts', async () => {
    const { send, calls } = fakeTmdb({
      '/trending/all/day': () => json({ page: 2, results: [{ id: 603, media_type: 'movie' }] }),
      '/movie/603': () => json({ id: 603, title: 'The Matrix', credits: { cast: [] }, external_ids: { imdb_id: 'tt0133093' }, videos: { results: [] } }),
    });
    const tmdb = client(send);
    expect(await tmdb.trending('all', 'day', 2)).toMatchObject({ page: 2 });
    expect(calls[0]!.pathname).toBe('/3/trending/all/day');
    expect(calls[0]!.searchParams.get('page')).toBe('2');

    const details = await tmdb.detailsRaw('movie', 603, 'es');
    expect(details).toMatchObject({ id: 603, credits: { cast: [] }, external_ids: { imdb_id: 'tt0133093' }, videos: { results: [] } });
    const url = calls[1]!;
    expect(url.pathname).toBe('/3/movie/603');
    expect(url.searchParams.get('language')).toBe('es');
    const append = (url.searchParams.get('append_to_response') ?? '').split(',').map((part) => part.trim());
    expect(append).toEqual(expect.arrayContaining(['credits', 'external_ids', 'videos']));
    expect(JSON.stringify(details)).not.toContain(KEY);
  });

  it('reads similar and recommended pages', async () => {
    const { send, calls } = fakeTmdb({
      '/movie/603/similar': () => json({ page: 4, results: [{ id: 604 }] }),
      '/tv/1396/recommendations': () => json({ page: 5, results: [{ id: 1397 }] }),
    });
    const tmdb = client(send);
    expect(await tmdb.similar('movie', 603, 4, 'es')).toMatchObject({ page: 4, results: [{ id: 604 }] });
    expect(await tmdb.recommendationsPage('tv', 1396, 5, 'es')).toMatchObject({ page: 5, results: [{ id: 1397 }] });
    expect(calls[0]!.pathname).toBe('/3/movie/603/similar');
    expect(calls[0]!.searchParams.get('page')).toBe('4');
    expect(calls[0]!.searchParams.get('language')).toBe('es');
    expect(calls[1]!.pathname).toBe('/3/tv/1396/recommendations');
    expect(calls[1]!.searchParams.get('page')).toBe('5');
    expect(calls[1]!.searchParams.get('language')).toBe('es');
  });

  it('reads person credits and genres', async () => {
    const { send, calls } = fakeTmdb({
      '/person/287/combined_credits': () => json({ id: 287, cast: [{ id: 603, media_type: 'movie' }], crew: [] }),
      '/genre/movie/list': () => json({ genres: [{ id: 28, name: 'Action' }] }),
      '/genre/tv/list': () => json({ genres: [{ id: 18, name: 'Drama' }] }),
    });
    const tmdb = client(send);
    expect(await tmdb.personCredits(287, 'es')).toMatchObject({ id: 287, cast: [{ id: 603 }] });
    expect(await tmdb.genres('movie', 'es')).toMatchObject({ genres: [{ id: 28, name: 'Action' }] });
    expect(await tmdb.genres('tv', 'es')).toMatchObject({ genres: [{ id: 18, name: 'Drama' }] });
    expect(calls[0]!.pathname).toBe('/3/person/287/combined_credits');
    expect(calls[0]!.searchParams.get('language')).toBe('es');
    expect(calls[1]!.pathname).toBe('/3/genre/movie/list');
    expect(calls[1]!.searchParams.get('language')).toBe('es');
    expect(calls[2]!.pathname).toBe('/3/genre/tv/list');
    expect(calls[2]!.searchParams.get('language')).toBe('es');
  });

  it('caches equal raw calls and reports the health', async () => {
    const { send } = fakeTmdb({ '/search/multi': () => json({ page: 1, results: [] }) });
    const tmdb = client(send);
    await tmdb.searchPage('same', 1, 'en');
    await tmdb.searchPage('same', 1, 'en');
    expect(send).toHaveBeenCalledTimes(1);
    expect(tmdb.status()).toMatchObject({ ok: true });
  });
});
