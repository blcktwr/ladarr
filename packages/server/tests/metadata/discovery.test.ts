import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../src/app.ts';
import { db, open } from '../../src/core/db.ts';
import type { SearchResult } from '../../src/metadata/tmdb.ts';
import { createTmdb } from '../../src/metadata/tmdb.ts';
import { movie, title } from '../helpers/test-fixtures.ts';

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

// Starts the app on a free port and opens a session. The database is in memory in the test env.
async function start(options: Parameters<typeof createApp>[0] = {}) {
  await open('unused.json');
  const server = createApp(options).listen(0);
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api`;
  const res = await fetch(`${base}/auth/setup`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'correct horse' }) });
  const cookie = res.headers.getSetCookie()[0]!.split(';')[0]!;
  return { base, cookie, close: () => server.close() };
}

type Row = { id: string; results: SearchResult[] };
type DiscoveryBody = { page: number; totalPages: number; rows: Row[] };

describe('discovery client', () => {
  it('discovers movies with the given params and maps the fields of a movie', async () => {
    const { send, calls } = fakeTmdb({
      '/discover/movie': () =>
        json({
          total_pages: 5,
          results: [
            { id: 603, title: 'The Matrix', release_date: '1999-03-31', overview: 'A hacker learns the truth.', poster_path: '/matrix.jpg', original_language: 'en' },
          ],
        }),
    });
    const { results, totalPages } = await client(send).discoverResults('movie', { sort_by: 'popularity.desc', page: '1' });
    expect(calls[0]!.pathname).toBe('/3/discover/movie');
    expect(calls[0]!.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(calls[0]!.searchParams.get('page')).toBe('1');
    expect(calls[0]!.searchParams.get('api_key')).toBe(KEY);
    expect(totalPages).toBe(5);
    expect(results).toEqual([
      { mediaType: 'movie', tmdbId: 603, title: 'The Matrix', year: 1999, overview: 'A hacker learns the truth.', posterPath: '/matrix.jpg', originalLanguage: 'en' },
    ]);
  });

  it('reads the name and the first air date of a series', async () => {
    const { send, calls } = fakeTmdb({
      '/discover/tv': () =>
        json({
          results: [{ id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', overview: 'A teacher turns cook.', poster_path: null, original_language: 'en' }],
        }),
    });
    const { results, totalPages } = await client(send).discoverResults('tv', { sort_by: 'popularity.desc' });
    expect(results).toEqual([
      { mediaType: 'tv', tmdbId: 1396, title: 'Breaking Bad', year: 2008, overview: 'A teacher turns cook.', posterPath: null, originalLanguage: 'en' },
    ]);
    // TMDB did not send the pages, so the list has no next page.
    expect(totalPages).toBe(1);
    expect(calls[0]!.pathname).toBe('/3/discover/tv');
  });
});

// The answers of the two lists. Each page has its own titles, so a test sees the page that it asked for.
function discoveryFake() {
  return fakeTmdb({
    '/discover/movie': (url) => {
      const page = url.searchParams.get('page');
      return json({
        page: Number(page),
        total_pages: 2,
        results: [
          page === '2'
            ? { id: 438631, title: 'Dune', release_date: '2021-09-15', overview: 'A duke moves to a desert planet.', poster_path: '/dune.jpg', original_language: 'en' }
            : { id: 603, title: 'The Matrix', release_date: '1999-03-31', overview: 'A hacker learns the truth.', poster_path: '/matrix.jpg', original_language: 'en' },
        ],
      });
    },
    '/discover/tv': (url) => {
      const page = url.searchParams.get('page');
      return json({
        page: Number(page),
        total_pages: 2,
        results: [
          page === '2'
            ? { id: 60059, name: 'Better Call Saul', first_air_date: '2015-02-08', overview: 'A lawyer takes a wrong turn.', poster_path: '/saul.jpg', original_language: 'en' }
            : { id: 1396, name: 'Breaking Bad', first_air_date: '2008-01-20', overview: 'A teacher turns cook.', poster_path: '/bad.jpg', original_language: 'en' },
        ],
      });
    },
    '/genre/movie/list': () =>
      json({
        genres: [
          { id: 28, name: 'Action' },
          { id: 12, name: 'Adventure' },
          { id: 878, name: 'Science Fiction' },
          { id: 35, name: 'Comedy' },
        ],
      }),
    '/genre/tv/list': () =>
      json({
        genres: [
          { id: 10759, name: 'Action & Adventure' },
          { id: 35, name: 'Comedy' },
          { id: 10762, name: 'Kids' },
          { id: 10765, name: 'Sci-Fi & Fantasy' },
        ],
      }),
    '/watch/providers/regions': () =>
      json({
        results: [
          { iso_3166_1: 'US', english_name: 'United States of America' },
          { iso_3166_1: 'ES', english_name: 'Spain' },
        ],
      }),
  });
}

describe('discovery route', () => {
  let base = '';
  let cookie = '';
  let close: () => void;
  const { send, calls } = discoveryFake();

  beforeAll(async () => {
    const started = await start({ tmdb: client(send) });
    base = started.base;
    cookie = started.cookie;
    close = started.close;
  });
  afterAll(() => close());
  beforeEach(() => {
    db.data.titles = {};
    calls.length = 0;
  });

  const discovery = async (query = '') => {
    const res = await fetch(`${base}/discovery${query}`, { headers: { cookie } });
    return { status: res.status, body: (await res.json()) as DiscoveryBody };
  };

  it('requires a session', async () => {
    expect((await fetch(`${base}/discovery`)).status).toBe(401);
  });

  it('answers the two rows of the first page in order and keeps the order of TMDB', async () => {
    const { status, body } = await discovery();
    expect(status).toBe(200);
    expect(body.page).toBe(1);
    expect(body.totalPages).toBe(2);
    const rows = body.rows;
    expect(rows.map((row) => row.id)).toEqual(['movies', 'series']);

    // The newest title is not first, so a sort by year would change these lists.
    expect(rows[0]!.results.map((result) => [result.mediaType, result.title, result.year])).toEqual([['movie', 'The Matrix', 1999]]);
    expect(rows[1]!.results.map((result) => [result.mediaType, result.title, result.year])).toEqual([['tv', 'Breaking Bad', 2008]]);

    const paths = calls.map((url) => url.pathname);
    expect(paths).toEqual(expect.arrayContaining(['/3/discover/movie', '/3/discover/tv']));
    expect(paths).toHaveLength(2);
    expect(calls.find((url) => url.pathname === '/3/discover/movie')!.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(calls.find((url) => url.pathname === '/3/discover/tv')!.searchParams.get('sort_by')).toBe('popularity.desc');
    expect(calls.every((url) => url.searchParams.get('page') === '1')).toBe(true);
  });

  it('reads the page of the query', async () => {
    const { body } = await discovery('?page=2');
    expect(body.page).toBe(2);
    expect(body.rows[0]!.results.map((result) => result.title)).toEqual(['Dune']);
    expect(body.rows[1]!.results.map((result) => result.title)).toEqual(['Better Call Saul']);
    expect(calls.map((url) => url.searchParams.get('page'))).toEqual(['2', '2']);
  });

  it('reads the first page for a page that is not a number', async () => {
    const { body } = await discovery('?page=none');
    expect(body.page).toBe(1);
    expect(calls.every((url) => url.searchParams.get('page') === '1')).toBe(true);
  });

  it('sends the sort of release date with the name of each media type', async () => {
    await discovery('?sort=release.asc');
    expect(calls.find((url) => url.pathname === '/3/discover/movie')!.searchParams.get('sort_by')).toBe('primary_release_date.asc');
    expect(calls.find((url) => url.pathname === '/3/discover/tv')!.searchParams.get('sort_by')).toBe('first_air_date.asc');
  });

  it('sends the sort of the rating', async () => {
    await discovery('?sort=rating.desc');
    expect(calls.map((url) => url.searchParams.get('sort_by'))).toEqual(['vote_average.desc', 'vote_average.desc']);
  });

  it('marks the titles that are in the library', async () => {
    db.data.titles['movie:603'] = movie({ key: 'movie:603', tmdbId: 603 });
    db.data.titles['tv:1396'] = title({ key: 'tv:1396', tmdbId: 1396, seriesType: 'anime' });

    const { body } = await discovery();
    const [moviesRow, seriesRow] = body.rows;
    expect(moviesRow!.results.find((result) => result.tmdbId === 603)).toMatchObject({ libraryKey: 'movie:603', seriesType: null });
    expect(seriesRow!.results.find((result) => result.tmdbId === 1396)).toMatchObject({ libraryKey: 'tv:1396', seriesType: 'anime' });
  });
});

describe('discovery with an unknown sort', () => {
  it('sorts by popularity', async () => {
    // The client keeps the answers of TMDB, so this test reads from a new client to see its requests.
    const fresh = discoveryFake();
    const { base, cookie, close } = await start({ tmdb: client(fresh.send) });
    try {
      const res = await fetch(`${base}/discovery?sort=none`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(fresh.calls.map((url) => url.searchParams.get('sort_by'))).toEqual(['popularity.desc', 'popularity.desc']);
    } finally {
      close();
    }
  });
});

describe('discovery without a TMDB client', () => {
  it('answers 503', async () => {
    const { base, cookie, close } = await start();
    try {
      const res = await fetch(`${base}/discovery`, { headers: { cookie } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'metadata_unavailable' });
    } finally {
      close();
    }
  });
});

describe('discovery when TMDB is down', () => {
  it('answers 503', async () => {
    const { send } = fakeTmdb({
      '/discover/movie': () => json({}, 503),
      '/discover/tv': () => json({}, 503),
    });
    const { base, cookie, close } = await start({ tmdb: client(send) });
    try {
      const res = await fetch(`${base}/discovery`, { headers: { cookie } });
      expect(res.status).toBe(503);
      expect(await res.json()).toEqual({ error: 'metadata_unavailable' });
    } finally {
      close();
    }
  });
});

// A fresh app for each filter test, because the client keeps the answers of TMDB.
async function withApp(run: (app: { base: string; cookie: string; calls: URL[] }) => Promise<void>) {
  const fake = discoveryFake();
  const started = await start({ tmdb: client(fake.send) });
  try {
    await run({ base: started.base, cookie: started.cookie, calls: fake.calls });
  } finally {
    started.close();
  }
}

describe('discovery filter params', () => {
  it('maps the genre of the filter to the genre of each media type', async () => {
    await withApp(async ({ base, cookie, calls }) => {
      const res = await fetch(`${base}/discovery?genre=${encodeURIComponent('Science Fiction')}`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(calls.find((url) => url.pathname === '/3/discover/movie')!.searchParams.get('with_genres')).toBe('878');
      expect(calls.find((url) => url.pathname === '/3/discover/tv')!.searchParams.get('with_genres')).toBe('10765');
    });
  });

  it('filters only the list that has the genre', async () => {
    await withApp(async ({ base, cookie, calls }) => {
      await fetch(`${base}/discovery?genre=Kids`, { headers: { cookie } });
      expect(calls.find((url) => url.pathname === '/3/discover/movie')!.searchParams.get('with_genres')).toBeNull();
      expect(calls.find((url) => url.pathname === '/3/discover/tv')!.searchParams.get('with_genres')).toBe('10762');
    });
  });

  it('sends the date range with the field of each media type', async () => {
    await withApp(async ({ base, cookie, calls }) => {
      await fetch(`${base}/discovery?from=2000-01-01&to=2010-12-31`, { headers: { cookie } });
      const movie = calls.find((url) => url.pathname === '/3/discover/movie')!.searchParams;
      expect(movie.get('primary_release_date.gte')).toBe('2000-01-01');
      expect(movie.get('primary_release_date.lte')).toBe('2010-12-31');
      const series = calls.find((url) => url.pathname === '/3/discover/tv')!.searchParams;
      expect(series.get('first_air_date.gte')).toBe('2000-01-01');
      expect(series.get('first_air_date.lte')).toBe('2010-12-31');
    });
  });

  it('sends the watch providers of the country', async () => {
    await withApp(async ({ base, cookie, calls }) => {
      await fetch(`${base}/discovery?providers=8,9&region=ES`, { headers: { cookie } });
      for (const mediaType of ['movie', 'tv']) {
        const params = calls.find((url) => url.pathname === `/3/discover/${mediaType}`)!.searchParams;
        expect(params.get('with_watch_providers')).toBe('8|9');
        expect(params.get('watch_region')).toBe('ES');
      }
    });
  });

  it('leaves out the providers without a country', async () => {
    await withApp(async ({ base, cookie, calls }) => {
      await fetch(`${base}/discovery?providers=8`, { headers: { cookie } });
      expect(calls.every((url) => url.searchParams.get('with_watch_providers') === null)).toBe(true);
    });
  });

  it('leaves out a date that is not a date', async () => {
    await withApp(async ({ base, cookie, calls }) => {
      await fetch(`${base}/discovery?from=none&to=2010`, { headers: { cookie } });
      expect(calls.every((url) => url.searchParams.get('primary_release_date.gte') === null)).toBe(true);
      expect(calls.every((url) => url.searchParams.get('first_air_date.lte') === null)).toBe(true);
    });
  });
});

describe('discovery filters route', () => {
  it('merges the genres of the two lists and sorts the countries', async () => {
    const fake = discoveryFake();
    const { base, cookie, close } = await start({ tmdb: client(fake.send) });
    try {
      const res = await fetch(`${base}/discovery/filters`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        genres: [
          { name: 'Action', movie: 28, tv: 10759 },
          { name: 'Adventure', movie: 12, tv: 10759 },
          { name: 'Science Fiction', movie: 878, tv: 10765 },
          { name: 'Comedy', movie: 35, tv: 35 },
          { name: 'Kids', movie: null, tv: 10762 },
        ],
        regions: [
          { code: 'ES', name: 'Spain' },
          { code: 'US', name: 'United States of America' },
        ],
      });
    } finally {
      close();
    }
  });

  it('requires a session', async () => {
    const fake = discoveryFake();
    const { base, close } = await start({ tmdb: client(fake.send) });
    try {
      expect((await fetch(`${base}/discovery/filters`)).status).toBe(401);
    } finally {
      close();
    }
  });

  it('answers 503 without a client', async () => {
    const { base, cookie, close } = await start();
    try {
      const res = await fetch(`${base}/discovery/filters`, { headers: { cookie } });
      expect(res.status).toBe(503);
    } finally {
      close();
    }
  });
});

function providersFake() {
  return fakeTmdb({
    '/watch/providers/movie': () =>
      json({
        results: [
          { provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg', display_priority: 2 },
          { provider_id: 9, provider_name: 'Amazon', logo_path: '/amazon.jpg', display_priority: 1 },
        ],
      }),
    '/watch/providers/tv': () =>
      json({
        results: [
          { provider_id: 8, provider_name: 'Netflix', logo_path: '/netflix.jpg', display_priority: 3 },
          { provider_id: 337, provider_name: 'Disney Plus', logo_path: '/disney.jpg', display_priority: 1 },
        ],
      }),
  });
}

describe('discovery providers route', () => {
  it('merges the two lists and keeps the order of priority', async () => {
    const fake = providersFake();
    const { base, cookie, close } = await start({ tmdb: client(fake.send) });
    try {
      const res = await fetch(`${base}/discovery/providers?region=ES`, { headers: { cookie } });
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual([
        { id: 9, name: 'Amazon', logoPath: '/amazon.jpg' },
        { id: 337, name: 'Disney Plus', logoPath: '/disney.jpg' },
        { id: 8, name: 'Netflix', logoPath: '/netflix.jpg' },
      ]);
      expect(fake.calls.every((url) => url.searchParams.get('watch_region') === 'ES')).toBe(true);
    } finally {
      close();
    }
  });

  it('rejects a region that is not a country', async () => {
    const fake = providersFake();
    const { base, cookie, close } = await start({ tmdb: client(fake.send) });
    try {
      const res = await fetch(`${base}/discovery/providers?region=Spain`, { headers: { cookie } });
      expect(res.status).toBe(400);
    } finally {
      close();
    }
  });

  it('requires a session', async () => {
    const fake = providersFake();
    const { base, close } = await start({ tmdb: client(fake.send) });
    try {
      expect((await fetch(`${base}/discovery/providers?region=ES`)).status).toBe(401);
    } finally {
      close();
    }
  });

  it('answers 503 without a client', async () => {
    const { base, cookie, close } = await start();
    try {
      const res = await fetch(`${base}/discovery/providers?region=ES`, { headers: { cookie } });
      expect(res.status).toBe(503);
    } finally {
      close();
    }
  });
});
