// A fake Wholphin for the Seerr API tests. It sends the calls that the Wholphin Seerr integration makes, in the
// order of the app: status, public settings, the user, genres, discover, search, details, credits, requests.
// The TMDB fixture holds the answers that the planned raw TMDB methods need.
import type { Db, MediaFile } from '../../src/core/db.ts';
import type { Episode, Title } from '../../src/library/library.ts';
import type { TitleMeta } from '../../src/metadata/tmdb.ts';

export const MOVIE_ID = 603;
export const SERIES_ID = 1396;
export const PERSON_ID = 287;
export const OTHER_MOVIE_ID = 604;
export const OTHER_SERIES_ID = 1397;

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const CREDITS = {
  cast: [{ id: PERSON_ID, name: 'Person Name', character: 'Lead', profile_path: '/person.jpg' }],
  crew: [{ id: PERSON_ID, name: 'Person Name', job: 'Director', department: 'Directing', profile_path: '/person.jpg' }],
};

const VIDEOS = { results: [{ id: 'v1', key: 'trailer', name: 'Trailer', site: 'YouTube', type: 'Trailer', size: 1080 }] };

const MOVIE_RESULT = {
  id: MOVIE_ID,
  media_type: 'movie',
  title: 'Movie Name',
  original_title: 'Movie Name',
  original_language: 'en',
  overview: 'A movie.',
  release_date: '2019-03-01',
  poster_path: '/movie.jpg',
  backdrop_path: '/movie-backdrop.jpg',
  vote_average: 8,
  vote_count: 100,
  genre_ids: [28],
  popularity: 10,
  adult: false,
  video: false,
};

const OTHER_MOVIE_RESULT = {
  ...MOVIE_RESULT,
  id: OTHER_MOVIE_ID,
  title: 'Other Movie',
  original_title: 'Other Movie',
  release_date: '2020-05-01',
  poster_path: '/other-movie.jpg',
  backdrop_path: null,
};

const SERIES_RESULT = {
  id: SERIES_ID,
  media_type: 'tv',
  name: 'Show Name',
  original_name: 'Show Name',
  original_language: 'en',
  overview: 'A show.',
  first_air_date: '2020-01-01',
  poster_path: '/show.jpg',
  backdrop_path: '/show-backdrop.jpg',
  vote_average: 8,
  vote_count: 100,
  genre_ids: [18],
  origin_country: ['US'],
  popularity: 10,
};

const OTHER_SERIES_RESULT = {
  ...SERIES_RESULT,
  id: OTHER_SERIES_ID,
  name: 'Other Show',
  original_name: 'Other Show',
  first_air_date: '2021-01-01',
  poster_path: '/other-show.jpg',
  backdrop_path: null,
};

const MOVIE_DETAILS = {
  ...MOVIE_RESULT,
  status: 'Released',
  runtime: 100,
  imdb_id: 'tt0133093',
  external_ids: { imdb_id: 'tt0133093', tvdb_id: null },
  release_dates: { results: [{ iso_3166_1: 'US', release_dates: [{ type: 4, release_date: '2019-06-01T00:00:00.000Z' }] }] },
  alternative_titles: { titles: [] },
  credits: CREDITS,
  videos: VIDEOS,
};

const OTHER_MOVIE_DETAILS = {
  ...MOVIE_DETAILS,
  ...OTHER_MOVIE_RESULT,
  release_dates: { results: [] },
};

const SERIES_DETAILS = {
  ...SERIES_RESULT,
  status: 'Returning Series',
  episode_run_time: [45],
  external_ids: { imdb_id: 'tt0903747', tvdb_id: 81189 },
  alternative_titles: { results: [] },
  seasons: [
    { season_number: 1, episode_count: 2, air_date: '2020-01-01' },
    { season_number: 2, episode_count: 1, air_date: '2021-01-01' },
  ],
  credits: CREDITS,
  videos: VIDEOS,
};

const OTHER_SERIES_DETAILS = {
  ...OTHER_SERIES_RESULT,
  status: 'Ended',
  episode_run_time: [30],
  external_ids: { tvdb_id: 81190 },
  alternative_titles: { results: [] },
  seasons: [{ season_number: 1, episode_count: 1, air_date: '2021-01-01' }],
  credits: CREDITS,
  videos: VIDEOS,
};

const SEASONS = {
  1: [
    { id: 9101, episode_number: 1, name: 'One', air_date: '2020-01-01', runtime: 45 },
    { id: 9102, episode_number: 2, name: 'Two', air_date: '2020-01-08', runtime: 45 },
  ],
  2: [{ id: 9201, episode_number: 1, name: 'Three', air_date: '2021-01-01', runtime: 45 }],
};

const MOVIE_GENRES = { genres: [{ id: 28, name: 'Action' }] };
const TV_GENRES = { genres: [{ id: 18, name: 'Drama' }] };

const PERSON_CREDITS = {
  id: PERSON_ID,
  cast: [
    { ...MOVIE_RESULT, character: 'Lead', profile_path: '/person.jpg' },
    { ...SERIES_RESULT, character: 'Guest', profile_path: '/person.jpg' },
  ],
  crew: [
    { ...OTHER_MOVIE_RESULT, job: 'Director', department: 'Directing', profile_path: '/person.jpg' },
    { ...OTHER_SERIES_RESULT, job: 'Writer', department: 'Writing', profile_path: '/person.jpg' },
  ],
};

export type TmdbFixture = {
  fetch: typeof fetch;
  calls: URL[];
  state: { outage: boolean };
};

// The paths that the Seerr adapter and the title add flow call. The answers do not depend on the query, so a test
// checks the query on `calls`.
export function createTmdbFixture(): TmdbFixture {
  const calls: URL[] = [];
  const state = { outage: false };
  const send = (async (input: URL | string) => {
    const url = new URL(String(input));
    calls.push(url);
    if (state.outage) return json({ status_message: 'Service unavailable' }, 503);

    const path = url.pathname.replace(/^\/3/, '');
    const page = Number(url.searchParams.get('page') ?? '1') || 1;

    if (path === '/search/multi') return json({ page, total_pages: 2, total_results: 4, results: [MOVIE_RESULT, SERIES_RESULT, OTHER_MOVIE_RESULT, OTHER_SERIES_RESULT] });
    if (path === '/discover/movie') return json({ page, total_pages: 2, total_results: 2, results: [MOVIE_RESULT, OTHER_MOVIE_RESULT] });
    if (path === '/discover/tv') return json({ page, total_pages: 2, total_results: 2, results: [SERIES_RESULT, OTHER_SERIES_RESULT] });
    if (path === '/trending/all/day') return json({ page, total_pages: 1, total_results: 4, results: [MOVIE_RESULT, SERIES_RESULT, OTHER_MOVIE_RESULT, OTHER_SERIES_RESULT] });
    if (path === '/genre/movie/list') return json(MOVIE_GENRES);
    if (path === '/genre/tv/list') return json(TV_GENRES);
    if (path === `/movie/${MOVIE_ID}`) return json(MOVIE_DETAILS);
    if (path === `/movie/${OTHER_MOVIE_ID}`) return json(OTHER_MOVIE_DETAILS);
    if (path === `/movie/${MOVIE_ID}/similar` || path === `/movie/${MOVIE_ID}/recommendations`) return json({ page, total_pages: 1, total_results: 1, results: [OTHER_MOVIE_RESULT] });
    if (path === `/movie/${OTHER_MOVIE_ID}/similar` || path === `/movie/${OTHER_MOVIE_ID}/recommendations`) return json({ page, total_pages: 1, total_results: 1, results: [MOVIE_RESULT] });
    if (path === `/tv/${SERIES_ID}`) return json(SERIES_DETAILS);
    if (path === `/tv/${OTHER_SERIES_ID}`) return json(OTHER_SERIES_DETAILS);
    if (path === `/tv/${SERIES_ID}/similar` || path === `/tv/${SERIES_ID}/recommendations`) return json({ page, total_pages: 1, total_results: 1, results: [OTHER_SERIES_RESULT] });
    if (path === `/tv/${OTHER_SERIES_ID}/similar` || path === `/tv/${OTHER_SERIES_ID}/recommendations`) return json({ page, total_pages: 1, total_results: 1, results: [SERIES_RESULT] });
    if (path === `/person/${PERSON_ID}/combined_credits`) return json(PERSON_CREDITS);

    const season = /^\/tv\/(1396|1397)\/season\/(\d+)$/.exec(path);
    if (season) {
      const episodes =
        season[1] === '1396'
          ? SEASONS[Number(season[2]) as keyof typeof SEASONS]
          : season[2] === '1'
            ? [{ id: 9301, episode_number: 1, name: 'One', air_date: '2021-01-01', runtime: 45 }]
            : undefined;
      if (episodes) return json({ episodes });
    }
    return json({ status_message: 'Not found', status_code: 34 }, 404);
  }) as typeof fetch;
  return { fetch: send, calls, state };
}

export class WholphinError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    super(`The Wholphin call failed with status ${status}`);
    this.status = status;
    this.body = body;
  }
}

type CallOptions = { body?: unknown; apiKey?: string | null; params?: Record<string, string | number | undefined> };
type Query = Record<string, string | number | undefined>;

export class FakeWholphin {
  baseUrl: string;
  apiKey: string;
  // Each call as "METHOD /path", without the query, in the order of the app.
  calls: string[] = [];

  constructor(baseUrl: string, apiKey: string) {
    this.baseUrl = baseUrl;
    this.apiKey = apiKey;
  }

  private url(path: string, params: Query = {}) {
    const url = new URL(`${this.baseUrl}${path}`);
    for (const [name, value] of Object.entries(params)) if (value !== undefined) url.searchParams.set(name, String(value));
    return url;
  }

  async raw(method: string, path: string, { body, apiKey = this.apiKey, params = {} }: CallOptions = {}) {
    this.calls.push(`${method} ${path}`);
    const res = await fetch(this.url(path, params), {
      method,
      headers: {
        accept: 'application/json',
        ...(apiKey ? { 'x-api-key': apiKey } : {}),
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json().catch(() => undefined) };
  }

  private async ok(method: string, path: string, options: CallOptions = {}) {
    const res = await this.raw(method, path, options);
    if (res.status < 200 || res.status >= 300) throw new WholphinError(res.status, res.body);
    return res.body;
  }

  // The public calls: Wholphin sends no key, and the adapter answers them.
  status = () => this.ok('GET', '/status', { apiKey: null });
  settingsPublic = () => this.ok('GET', '/settings/public', { apiKey: null });
  logout = () => this.ok('POST', '/auth/logout');

  me = () => this.ok('GET', '/auth/me');
  search = (query: string, page = 1, language?: string) => this.ok('GET', '/search', { params: { query, page, language } });
  discoverMovies = (params: Query = {}) => this.ok('GET', '/discover/movies', { params });
  discoverTv = (params: Query = {}) => this.ok('GET', '/discover/tv', { params });
  trending = (page = 1, language?: string) => this.ok('GET', '/discover/trending', { params: { page, language } });
  upcomingMovies = (page = 1, language?: string) => this.ok('GET', '/discover/movies/upcoming', { params: { page, language } });
  upcomingTv = (page = 1, language?: string) => this.ok('GET', '/discover/tv/upcoming', { params: { page, language } });
  genreSlider = (mediaType: 'movie' | 'tv', language?: string) => this.ok('GET', `/discover/genreslider/${mediaType}`, { params: { language } });

  movie = (id: number, language?: string) => this.ok('GET', `/movie/${id}`, { params: { language } });
  movieRatings = (id: number) => this.ok('GET', `/movie/${id}/ratings`);
  movieSimilar = (id: number, page = 1, language?: string) => this.ok('GET', `/movie/${id}/similar`, { params: { page, language } });
  movieRecommendations = (id: number, page = 1, language?: string) => this.ok('GET', `/movie/${id}/recommendations`, { params: { page, language } });

  tv = (id: number, language?: string) => this.ok('GET', `/tv/${id}`, { params: { language } });
  tvRatings = (id: number) => this.ok('GET', `/tv/${id}/ratings`);
  tvSimilar = (id: number, page = 1, language?: string) => this.ok('GET', `/tv/${id}/similar`, { params: { page, language } });
  tvRecommendations = (id: number, page = 1, language?: string) => this.ok('GET', `/tv/${id}/recommendations`, { params: { page, language } });

  personCredits = (id: number, language?: string) => this.ok('GET', `/person/${id}/combined_credits`, { params: { language } });
  requests = () => this.ok('GET', '/request');
  request = (body: Record<string, unknown>) => this.ok('POST', '/request', { body });
}

const metaOf = (mediaType: 'movie' | 'tv', tmdbId: number, title: string, tvdbId: number | null): TitleMeta => ({
  mediaType,
  tmdbId,
  title,
  year: mediaType === 'movie' ? 2019 : 2020,
  overview: '',
  posterPath: null,
  originalLanguage: 'en',
  originalTitle: title,
  aliases: [],
  date: mediaType === 'movie' ? '2019-03-01' : '2020-01-01',
  status: mediaType === 'movie' ? 'Released' : 'Returning Series',
  rating: null,
  votes: 0,
  backdropPath: null,
  runtime: mediaType === 'movie' ? 100 : 45,
  imdbId: null,
  tvdbId,
  releaseDates: [],
  seasons: [],
});

const baseTitle = (mediaType: 'movie' | 'tv', tmdbId: number, title: string, tvdbId: number | null): Title => ({
  key: `${mediaType}:${tmdbId}`,
  mediaType,
  tmdbId,
  meta: metaOf(mediaType, tmdbId, title, tvdbId),
  metaLoadedAt: 1,
  refreshedAt: 0,
  addedAt: 0,
  paused: false,
  policy: 'all',
  futureFrom: 0,
  seriesType: 'standard',
  preset: 'p1080',
  rootId: mediaType,
  folder: null,
  manualRelease: false,
  seasonOverrides: {},
  episodesLoadedAt: mediaType === 'tv' ? 1 : null,
  episodes: [],
  fileId: null,
});

const episodesOf = (tmdbId: number): Episode[] => {
  const rows =
    tmdbId === SERIES_ID
      ? [
          { tmdbId: 9101, season: 1, number: 1, name: 'One', airDate: '2020-01-01', runtime: 45 },
          { tmdbId: 9102, season: 1, number: 2, name: 'Two', airDate: '2020-01-08', runtime: 45 },
          { tmdbId: 9201, season: 2, number: 1, name: 'Three', airDate: '2021-01-01', runtime: 45 },
        ]
      : [{ tmdbId: 9301, season: 1, number: 1, name: 'One', airDate: '2021-01-01', runtime: 45 }];
  return rows.map((row) => ({ ...row, override: null, fileId: null }));
};

function addFile(db: Db, title: Title, path: string, episodes: { season: number; number: number }[]): MediaFile {
  const id = `${title.key}:file:${Object.keys(db.data.files).length + 1}`;
  const file: MediaFile = { id, titleKey: title.key, path, sizeBytes: 10, mtimeMs: 0, episodes, missing: false, addedAt: 0 };
  db.data.files[id] = file;
  return file;
}

type MovieSeed = { tmdbId?: number; file?: boolean; paused?: boolean };

export function seedMovie(db: Db, { tmdbId = MOVIE_ID, file = false, paused = false }: MovieSeed = {}): Title {
  const title = baseTitle('movie', tmdbId, tmdbId === MOVIE_ID ? 'Movie Name' : 'Other Movie', null);
  title.paused = paused;
  db.data.titles[title.key] = title;
  if (file) title.fileId = addFile(db, title, `${title.meta.title} (2019)/${title.meta.title} (2019).mkv`, []).id;
  return title;
}

type SeriesSeed = { tmdbId?: number; files?: [season: number, number: number][]; paused?: boolean };

export function seedSeries(db: Db, { tmdbId = SERIES_ID, files = [], paused = false }: SeriesSeed = {}): Title {
  const title = baseTitle('tv', tmdbId, tmdbId === SERIES_ID ? 'Show Name' : 'Other Show', tmdbId === SERIES_ID ? 81189 : 81190);
  title.paused = paused;
  title.episodes = episodesOf(tmdbId);
  title.meta.seasons =
    tmdbId === SERIES_ID
      ? [
          { seasonNumber: 1, episodeCount: 2, airDate: '2020-01-01' },
          { seasonNumber: 2, episodeCount: 1, airDate: '2021-01-01' },
        ]
      : [{ seasonNumber: 1, episodeCount: 1, airDate: '2021-01-01' }];
  db.data.titles[title.key] = title;
  for (const [season, number] of files) {
    const episode = title.episodes.find((item) => item.season === season && item.number === number);
    if (!episode) continue;
    const file = addFile(db, title, `${title.meta.title}/Season ${season}/${title.meta.title} - S${String(season).padStart(2, '0')}E${String(number).padStart(2, '0')}.mkv`, [{ season, number }]);
    episode.fileId = file.id;
  }
  return title;
}
