import type { MediaType } from '@ladarr/shared/enums';
import express, { Router, type RequestHandler, type Response } from 'express';
import { safeEqual } from '../core/auth.ts';
import { type Db, db } from '../core/db.ts';
import { onError } from '../core/errors.ts';
import { isMonitored, seriesCounts, type Title } from '../library/library.ts';
import { AddError, addTitle } from '../library/tools/add.ts';
import { TmdbError } from '../metadata/tmdb.ts';
import { restoreGate, type Restorer } from '../system/restore.ts';
import { clock, firstProfileId, isObject, presentFile, type CompatDeps } from './common.ts';

// The request that a caller of the Seerr API sent. The ID stays the same after a restart.
export type SeerrRequest = {
  id: number;
  mediaType: MediaType;
  tmdbId: number;
  seasons: number[];
  createdAt: number;
  updatedAt: number;
};

const UNKNOWN = 1;
const PROCESSING = 3;
const PARTIAL = 4;
const AVAILABLE = 5;

// REQUEST | REQUEST_MOVIE | REQUEST_TV. Wholphin reads this value to show the request buttons.
const PERMISSIONS = 32 | 262_144 | 524_288;

const ACTIVE_STAGES = new Set(['fetching', 'sending', 'downloading', 'validating', 'importing']);

const fail = (res: Response, status: number, message: string) => void res.status(status).json({ status, message });
const unsupported = (message: string): RequestHandler => (_req, res) => fail(res, 501, message);
const list = (value: unknown) => (Array.isArray(value) ? value : []);
const iso = (ms: number) => new Date(ms).toISOString();

function tmdbFailure(res: Response, error: unknown) {
  if (!(error instanceof TmdbError)) throw error;
  if (error.code === 'not_found') return fail(res, 404, 'Not found.');
  fail(res, 503, 'TMDB is not available.');
}

function tmdbMissing(res: Response) {
  fail(res, 503, 'The TMDB key is not set.');
}

function positiveId(value: unknown) {
  const number = typeof value === 'string' && /^[1-9]\d{0,9}$/.test(value) ? Number(value) : undefined;
  return number;
}

function languageOf(query: Record<string, unknown>) {
  return typeof query.language === 'string' ? query.language : undefined;
}

function pageOf(value: unknown) {
  const text = typeof value === 'string' ? value : undefined;
  const number = text && /^[1-9]\d{0,5}$/.test(text) ? Number(text) : 1;
  return String(number);
}

export const seerrAuth = (): RequestHandler => {
  return (req, res, next) => {
    const sent = req.get('x-api-key') ?? (typeof req.query.apikey === 'string' ? req.query.apikey : undefined);
    if (sent && db.data.apiKey && safeEqual(sent, db.data.apiKey)) return next();
    fail(res, 401, 'Unauthorized');
  };
};

export const seerrNotFound: RequestHandler = (_req, res) => fail(res, 404, 'Not found.');

export const seerrWrongPath =
  (urlBase: string): RequestHandler =>
  (_req, res) =>
    fail(res, 404, `Use ${urlBase}/seerr/api/v1.`);

function titleOf(mediaType: MediaType, tmdbId: number) {
  return db.data.titles[`${mediaType}:${tmdbId}`];
}

function activeQueue(key: string) {
  return Object.values(db.data.queue).some((entry) => entry.titleKey === key && ACTIVE_STAGES.has(entry.stage) && entry.branch !== 'cancelled');
}

function requestsFor(mediaType: MediaType, tmdbId: number) {
  return Object.values(db.data.seerr.requests)
    .filter((request) => request.mediaType === mediaType && request.tmdbId === tmdbId)
    .sort((a, b) => a.id - b.id);
}

function mediaStatus(title: Title, requested: boolean) {
  if (title.mediaType === 'movie') {
    if (presentFile(title.fileId)) return AVAILABLE;
    if (title.paused && !activeQueue(title.key) && !requested) return UNKNOWN;
    return PROCESSING;
  }
  const counts = seriesCounts(title, clock());
  if (counts.eligible > 0 && counts.available >= counts.eligible) return AVAILABLE;
  if (counts.available > 0) return PARTIAL;
  if (title.paused && !activeQueue(title.key) && !requested) return UNKNOWN;
  return PROCESSING;
}

function seasonMonitored(title: Title, season: number) {
  const choice = title.seasonOverrides[season];
  if (choice) return choice === 'monitored';
  const episodes = title.episodes.filter((episode) => episode.season === season);
  if (episodes.length) return episodes.some((episode) => isMonitored(title, episode, db.data.settings));
  return season !== 0 && title.policy === 'all';
}

function seasonStatus(title: Title, season: number) {
  const episodes = title.episodes.filter((episode) => episode.season === season);
  const total = episodes.length || title.meta.seasons.find((item) => item.seasonNumber === season)?.episodeCount || 0;
  const withFile = episodes.filter((episode) => presentFile(episode.fileId)).length;
  if (total > 0 && withFile >= total) return AVAILABLE;
  if (withFile > 0) return PARTIAL;
  return seasonMonitored(title, season) ? PROCESSING : UNKNOWN;
}

function seasonRows(title: Title) {
  const known = title.meta.seasons.length ? title.meta.seasons : [...new Map(title.episodes.map((episode) => [episode.season, episode])).values()].map((episode) => ({ seasonNumber: episode.season, episodeCount: 0, airDate: null }));
  return known.map((season) => ({
    seasonNumber: season.seasonNumber,
    episodeCount: season.episodeCount,
    airDate: season.airDate ?? null,
    name: '',
    overview: '',
    posterPath: null,
    status: seasonStatus(title, season.seasonNumber),
    status4k: UNKNOWN,
  }));
}

function userResource() {
  const createdAt = db.data.owner?.createdAt ?? Date.now();
  return {
    id: 1,
    email: 'owner@ladarr',
    username: 'ladarr',
    userType: 1,
    permissions: PERMISSIONS,
    createdAt: iso(createdAt),
    updatedAt: iso(createdAt),
    requestCount: Object.keys(db.data.seerr.requests).length,
  };
}

function mediaInfo(mediaType: MediaType, tmdbId: number, withRequests = true): Record<string, unknown> {
  const title = titleOf(mediaType, tmdbId);
  const requests = requestsFor(mediaType, tmdbId);
  const status = title ? mediaStatus(title, requests.length > 0) : UNKNOWN;
  return {
    id: tmdbId,
    tmdbId,
    tvdbId: title?.meta.tvdbId ?? null,
    status,
    ...(mediaType === 'tv' ? { seasons: title ? seasonRows(title) : [] } : {}),
    ...(withRequests ? { requests: requests.map((request) => requestResource(request, false)) } : {}),
    createdAt: title ? iso(title.addedAt) : null,
    updatedAt: title ? iso(title.refreshedAt || title.addedAt) : null,
    jellyfinMediaId: null,
  };
}

function requestStatus(request: SeerrRequest) {
  const title = titleOf(request.mediaType, request.tmdbId);
  if (!title) return 3;
  return mediaStatus(title, true) === AVAILABLE ? 5 : 2;
}

function requestSeasonStatus(request: SeerrRequest, season: number) {
  const title = titleOf(request.mediaType, request.tmdbId);
  if (!title) return 3;
  return seasonStatus(title, season) === AVAILABLE ? 5 : 2;
}

function requestResource(request: SeerrRequest, withMedia = true): Record<string, unknown> {
  return {
    id: request.id,
    status: requestStatus(request),
    ...(withMedia ? { media: mediaInfo(request.mediaType, request.tmdbId, false) } : {}),
    createdAt: iso(request.createdAt),
    updatedAt: iso(request.updatedAt),
    requestedBy: userResource(),
    modifiedBy: null,
    is4k: false,
    serverid: 0,
    profileid: 0,
    rootFolder: '',
    type: request.mediaType,
    ...(request.mediaType === 'tv' ? { seasons: request.seasons.map((season) => ({ seasonNumber: season, status: requestSeasonStatus(request, season), status4k: UNKNOWN })) } : {}),
  };
}

const textValue = (value: unknown) => (typeof value === 'string' ? value : '');
const numberValue = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : 0);
const textOrNull = (value: unknown) => (typeof value === 'string' ? value : null);

function genresOf(value: unknown) {
  return list(value).flatMap((genre) => (isObject(genre) && typeof genre.id === 'number' ? [{ id: genre.id, name: textValue(genre.name) }] : []));
}

function companiesOf(value: unknown) {
  return list(value).flatMap((company) =>
    isObject(company) && typeof company.id === 'number'
      ? [{ id: company.id, name: textValue(company.name), logoPath: textOrNull(company.logo_path), originCountry: textValue(company.origin_country) }]
      : [],
  );
}

function languagesOf(value: unknown) {
  return list(value).flatMap((language) =>
    isObject(language) ? [{ iso_639_1: textValue(language.iso_639_1), name: textValue(language.name), englishName: textOrNull(language.english_name) }] : [],
  );
}

function externalIdsOf(value: unknown) {
  const ids = isObject(value) ? value : {};
  return {
    facebookId: textOrNull(ids.facebook_id),
    freebaseId: textOrNull(ids.freebase_id),
    freebaseMid: textOrNull(ids.freebase_mid),
    imdbId: textOrNull(ids.imdb_id),
    instagramId: textOrNull(ids.instagram_id),
    tvdbid: typeof ids.tvdb_id === 'number' ? ids.tvdb_id : null,
    tvrageid: typeof ids.tvrage_id === 'number' ? ids.tvrage_id : null,
    twitterId: textOrNull(ids.twitter_id),
  };
}

function releasesOf(value: unknown) {
  const results = list(isObject(value) ? value.results : undefined);
  return {
    results: results.flatMap((entry) =>
      isObject(entry)
        ? [
            {
              iso_3166_1: textValue(entry.iso_3166_1),
              rating: textOrNull(entry.rating),
              release_dates: list(entry.release_dates).flatMap((date) =>
                isObject(date)
                  ? [
                      {
                        certification: textValue(date.certification),
                        iso_639_1: textOrNull(date.iso_639_1),
                        note: textOrNull(date.note),
                        release_date: textValue(date.release_date),
                        type: numberValue(date.type),
                      },
                    ]
                  : [],
              ),
            },
          ]
        : [],
    ),
  };
}

function videosOf(value: unknown) {
  const results = list(isObject(value) ? value.results : undefined);
  return results.flatMap((video) => {
    if (!isObject(video) || typeof video.key !== 'string') return [];
    const site = textValue(video.site);
    return [
      {
        url: site === 'YouTube' ? `https://www.youtube.com/watch?v=${video.key}` : '',
        key: video.key,
        name: textValue(video.name),
        size: numberValue(video.size),
        type: textValue(video.type),
        site,
      },
    ];
  });
}

function detailCastOf(value: unknown) {
  return list(value).flatMap((person) =>
    isObject(person)
      ? [
          {
            id: numberValue(person.id),
            name: textValue(person.name),
            character: textValue(person.character),
            profilePath: textOrNull(person.profile_path),
            order: numberValue(person.order),
            gender: numberValue(person.gender),
            castId: numberValue(person.cast_id),
            creditId: textValue(person.credit_id),
          },
        ]
      : [],
  );
}

function detailCrewOf(value: unknown) {
  return list(value).flatMap((person) =>
    isObject(person)
      ? [
          {
            id: numberValue(person.id),
            name: textValue(person.name),
            job: textValue(person.job),
            department: textValue(person.department),
            profilePath: textOrNull(person.profile_path),
            gender: numberValue(person.gender),
            creditId: textValue(person.credit_id),
          },
        ]
      : [],
  );
}

function seasonOf(value: unknown) {
  if (!isObject(value)) return undefined;
  return {
    id: numberValue(value.id),
    airDate: textOrNull(value.air_date),
    episodeCount: numberValue(value.episode_count),
    name: textValue(value.name),
    overview: textValue(value.overview),
    posterPath: textOrNull(value.poster_path),
    seasonNumber: numberValue(value.season_number),
    status: UNKNOWN,
    status4k: UNKNOWN,
  };
}

function movieResult(item: Record<string, unknown>) {
  const id = numberValue(item.id);
  return {
    id,
    mediaType: 'movie',
    popularity: numberValue(item.popularity),
    posterPath: textOrNull(item.poster_path),
    backdropPath: textOrNull(item.backdrop_path),
    voteCount: numberValue(item.vote_count),
    voteAverage: numberValue(item.vote_average),
    genreIds: list(item.genre_ids).filter((genre): genre is number => typeof genre === 'number'),
    overview: textValue(item.overview),
    originalLanguage: textValue(item.original_language),
    title: textValue(item.title),
    originalTitle: textValue(item.original_title),
    releaseDate: textValue(item.release_date),
    adult: Boolean(item.adult),
    video: Boolean(item.video),
    mediaInfo: mediaInfo('movie', id),
  };
}

function tvResult(item: Record<string, unknown>) {
  const id = numberValue(item.id);
  return {
    id,
    mediaType: 'tv',
    popularity: numberValue(item.popularity),
    posterPath: textOrNull(item.poster_path),
    backdropPath: textOrNull(item.backdrop_path),
    voteCount: numberValue(item.vote_count),
    voteAverage: numberValue(item.vote_average),
    genreIds: list(item.genre_ids).filter((genre): genre is number => typeof genre === 'number'),
    overview: textValue(item.overview),
    originalLanguage: textValue(item.original_language),
    name: textValue(item.name),
    originalName: textValue(item.original_name),
    originCountry: list(item.origin_country).filter((country): country is string => typeof country === 'string'),
    firstAirDate: textValue(item.first_air_date),
    mediaInfo: mediaInfo('tv', id),
  };
}

function personResult(item: Record<string, unknown>): Record<string, unknown> {
  return {
    id: numberValue(item.id),
    profilePath: textOrNull(item.profile_path),
    adult: Boolean(item.adult),
    mediaType: 'person',
    knownFor: list(item.known_for).flatMap((known) => (isObject(known) ? [resultItem(known)] : [])),
  };
}

function personCreditOf(item: unknown) {
  if (!isObject(item)) return {};
  const mediaType = textValue(item.media_type);
  const id = numberValue(item.id);
  return {
    id,
    originalLanguage: textOrNull(item.original_language),
    episodeCount: numberValue(item.episode_count),
    overview: textValue(item.overview),
    originCountry: list(item.origin_country).filter((country): country is string => typeof country === 'string'),
    originalName: textOrNull(item.original_name),
    voteCount: numberValue(item.vote_count),
    name: textOrNull(item.name),
    mediaType,
    popularity: numberValue(item.popularity),
    creditId: textOrNull(item.credit_id),
    backdropPath: textOrNull(item.backdrop_path),
    firstAirDate: textOrNull(item.first_air_date),
    voteAverage: numberValue(item.vote_average),
    genreIds: list(item.genre_ids).filter((genre): genre is number => typeof genre === 'number'),
    posterPath: textOrNull(item.poster_path),
    profilePath: textOrNull(item.profile_path),
    originalTitle: textOrNull(item.original_title),
    video: Boolean(item.video),
    title: textOrNull(item.title),
    adult: Boolean(item.adult),
    releaseDate: textOrNull(item.release_date),
    ...(item.character !== undefined ? { character: textValue(item.character) } : {}),
    ...(item.department !== undefined ? { department: textValue(item.department) } : {}),
    ...(item.job !== undefined ? { job: textValue(item.job) } : {}),
    ...(mediaType === 'movie' || mediaType === 'tv' ? { mediaInfo: mediaInfo(mediaType, id) } : {}),
  };
}

function movieDetailsOf(raw: Record<string, unknown>) {
  const id = numberValue(raw.id);
  return {
    id,
    imdbId: textOrNull(raw.imdb_id),
    adult: Boolean(raw.adult),
    backdropPath: textOrNull(raw.backdrop_path),
    posterPath: textOrNull(raw.poster_path),
    budget: numberValue(raw.budget),
    genres: genresOf(raw.genres),
    homepage: textValue(raw.homepage),
    relatedVideos: videosOf(raw.videos),
    originalLanguage: textValue(raw.original_language),
    originalTitle: textValue(raw.original_title),
    overview: textValue(raw.overview),
    popularity: numberValue(raw.popularity),
    productionCompanies: companiesOf(raw.production_companies),
    productionCountries: list(raw.production_countries).flatMap((country) => (isObject(country) ? [{ iso_3166_1: textValue(country.iso_3166_1), name: textValue(country.name) }] : [])),
    releaseDate: textValue(raw.release_date),
    releases: releasesOf(raw.release_dates),
    revenue: numberValue(raw.revenue),
    runtime: numberValue(raw.runtime),
    spokenLanguages: languagesOf(raw.spoken_languages),
    status: textValue(raw.status),
    tagline: textValue(raw.tagline),
    title: textValue(raw.title),
    video: Boolean(raw.video),
    voteAverage: numberValue(raw.vote_average),
    voteCount: numberValue(raw.vote_count),
    credits: { cast: detailCastOf(isObject(raw.credits) ? raw.credits.cast : undefined), crew: detailCrewOf(isObject(raw.credits) ? raw.credits.crew : undefined) },
    externalIds: externalIdsOf(raw.external_ids),
    mediaInfo: mediaInfo('movie', id),
  };
}

function tvDetailsOf(raw: Record<string, unknown>) {
  const id = numberValue(raw.id);
  const seasons = list(raw.seasons).flatMap((season) => {
    const mapped = seasonOf(season);
    return mapped ? [mapped] : [];
  });
  const info = mediaInfo('tv', id);
  if (Array.isArray(info.seasons) && info.seasons.length === 0) info.seasons = seasons;
  return {
    id,
    backdropPath: textOrNull(raw.backdrop_path),
    posterPath: textOrNull(raw.poster_path),
    episodeRunTime: list(raw.episode_run_time).filter((time): time is number => typeof time === 'number'),
    firstAirDate: textValue(raw.first_air_date),
    genres: genresOf(raw.genres),
    homepage: textValue(raw.homepage),
    inProduction: Boolean(raw.in_production),
    languages: list(raw.languages).filter((language): language is string => typeof language === 'string'),
    lastAirDate: textOrNull(raw.last_air_date),
    name: textValue(raw.name),
    networks: companiesOf(raw.networks),
    numberOfEpisodes: numberValue(raw.number_of_episodes),
    numberOfSeason: numberValue(raw.number_of_seasons),
    originCountry: list(raw.origin_country).filter((country): country is string => typeof country === 'string'),
    originalLanguage: textValue(raw.original_language),
    originalName: textValue(raw.original_name),
    overview: textValue(raw.overview),
    popularity: numberValue(raw.popularity),
    productionCompanies: companiesOf(raw.production_companies),
    productionCountries: list(raw.production_countries).flatMap((country) => (isObject(country) ? [{ iso_3166_1: textValue(country.iso_3166_1), name: textValue(country.name) }] : [])),
    seasons,
    spokenLanguages: languagesOf(raw.spoken_languages),
    tagline: textValue(raw.tagline),
    type: textValue(raw.type),
    voteAverage: numberValue(raw.vote_average),
    voteCount: numberValue(raw.vote_count),
    credits: { cast: detailCastOf(isObject(raw.credits) ? raw.credits.cast : undefined), crew: detailCrewOf(isObject(raw.credits) ? raw.credits.crew : undefined) },
    externalIds: externalIdsOf(raw.external_ids),
    relatedVideos: videosOf(raw.videos),
    mediaInfo: info,
  };
}

function resultItem(item: unknown, fallbackType?: MediaType): unknown {
  if (!isObject(item)) return item;
  const mediaType = textValue(item.media_type) || fallbackType;
  if (mediaType === 'movie') return movieResult(item);
  if (mediaType === 'tv') return tvResult(item);
  if (mediaType === 'person') return personResult(item);
  return item;
}

function pageResource(raw: unknown, fallbackType?: MediaType) {
  const data = isObject(raw) ? raw : {};
  return {
    page: typeof data.page === 'number' ? data.page : 1,
    totalPages: typeof data.total_pages === 'number' ? data.total_pages : 1,
    totalResults: typeof data.total_results === 'number' ? data.total_results : 0,
    results: list(data.results).map((item) => resultItem(item, fallbackType)),
  };
}

const DISCOVER_NAMES: Record<string, string> = {
  page: 'page',
  language: 'language',
  genre: 'with_genres',
  network: 'with_networks',
  keywords: 'with_keywords',
  excludeKeywords: 'without_keywords',
  sortBy: 'sort_by',
  firstAirDateGte: 'first_air_date.gte',
  firstAirDateLte: 'first_air_date.lte',
  primaryReleaseDateGte: 'primary_release_date.gte',
  primaryReleaseDateLte: 'primary_release_date.lte',
  studio: 'with_companies',
  withRuntimeGte: 'with_runtime.gte',
  withRuntimeLte: 'with_runtime.lte',
  voteAverageGte: 'vote_average.gte',
  voteAverageLte: 'vote_average.lte',
  voteCountGte: 'vote_count.gte',
  voteCountLte: 'vote_count.lte',
  watchRegion: 'watch_region',
  watchProviders: 'with_watch_providers',
  status: 'with_status',
  certification: 'certification',
  certificationGte: 'certification.gte',
  certificationLte: 'certification.lte',
  certificationCountry: 'certification_country',
};

function discoverParams(query: Record<string, unknown>, mediaType: MediaType) {
  const params: Record<string, string> = {};
  for (const [seerr, tmdb] of Object.entries(DISCOVER_NAMES)) {
    const value = typeof query[seerr] === 'string' ? query[seerr] : Array.isArray(query[seerr]) && typeof query[seerr][0] === 'string' ? query[seerr][0] : undefined;
    if (value !== undefined) params[tmdb] = value;
  }
  params.page = pageOf(params.page);
  params.sort_by ??= 'popularity.desc';
  if (mediaType === 'movie') params.include_adult = 'false';
  return params;
}

function readSeasonList(value: unknown) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value) || value.length > 200 || !value.every((season) => Number.isInteger(season) && season >= 0)) return null;
  return value as number[];
}

function rootOf(mediaType: MediaType) {
  const id = db.data.settings.defaultRoots[mediaType];
  if (id && db.data.roots[id]?.mediaType === mediaType) return db.data.roots[id];
  return Object.values(db.data.roots).find((root) => root.mediaType === mediaType);
}

function applySeasons(title: Title, requested: number[]) {
  if (title.mediaType !== 'tv') return;
  const known = title.meta.seasons.length ? title.meta.seasons.map((season) => season.seasonNumber) : [...new Set(title.episodes.map((episode) => episode.season))];
  const wanted = new Set(requested.length ? requested : known.filter((season) => season !== 0));
  for (const season of known) title.seasonOverrides[season] = wanted.has(season) ? 'monitored' : 'unmonitored';
  for (const season of wanted) if (!known.includes(season)) title.seasonOverrides[season] = 'monitored';
}

function requestedSeasons(title: Title, list: number[]) {
  if (title.mediaType !== 'tv') return [];
  const known = title.meta.seasons.length ? title.meta.seasons.map((season) => season.seasonNumber) : [...new Set(title.episodes.map((episode) => episode.season))];
  return list.length ? list : known.filter((season) => season !== 0);
}

export function seerrRouter(deps: CompatDeps) {
  const router = Router();

  router.get('/status', (_req, res) => void res.json({ version: '3.5.1', commitTag: 'ladarr' }));
  router.get('/settings/public', (_req, res) =>
    void res.json({ initialized: true, movie4kEnabled: false, series4kEnabled: false, cacheImages: false }),
  );
  router.post('/auth/local', unsupported('Use the API key.'));
  router.post('/auth/jellyfin', unsupported('Use the API key.'));
  router.post('/auth/logout', (_req, res) => void res.json({}));

  router.use(seerrAuth());

  router.get('/auth/me', (_req, res) => void res.json(userResource()));

  router.get('/search', async (req, res) => {
    const query = typeof req.query.query === 'string' ? req.query.query : undefined;
    if (!query) return fail(res, 400, 'The query is missing.');
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      res.json(pageResource(await deps.tmdb.searchPage(query, Number(pageOf(req.query.page)), languageOf(req.query))));
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  const discover = (mediaType: MediaType): RequestHandler => async (req, res) => {
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const params = discoverParams(req.query as Record<string, unknown>, mediaType);
      res.json(pageResource(await deps.tmdb.discover(mediaType, params), mediaType));
    } catch (error) {
      tmdbFailure(res, error);
    }
  };

  router.get('/discover/movies', discover('movie'));
  router.get('/discover/tv', discover('tv'));

  router.get('/discover/trending', async (req, res) => {
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      res.json(pageResource(await deps.tmdb.trending('all', 'day', Number(pageOf(req.query.page)), languageOf(req.query))));
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  router.get('/discover/movies/upcoming', async (req, res) => {
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const params = discoverParams(req.query as Record<string, unknown>, 'movie');
      params['primary_release_date.gte'] = new Date().toISOString().slice(0, 10);
      res.json(pageResource(await deps.tmdb.discover('movie', params), 'movie'));
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  router.get('/discover/tv/upcoming', async (req, res) => {
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const params = discoverParams(req.query as Record<string, unknown>, 'tv');
      params['first_air_date.gte'] = new Date().toISOString().slice(0, 10);
      res.json(pageResource(await deps.tmdb.discover('tv', params), 'tv'));
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  router.get('/discover/genreslider/movie', async (req, res) => {
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const raw = await deps.tmdb.genres('movie', languageOf(req.query));
      const genres = isObject(raw) ? list(raw.genres) : [];
      res.json(genres.flatMap((genre) => (isObject(genre) && typeof genre.id === 'number' && typeof genre.name === 'string' ? [{ id: genre.id, name: genre.name, backdrops: [] }] : [])));
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  router.get('/discover/genreslider/tv', async (req, res) => {
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const raw = await deps.tmdb.genres('tv', languageOf(req.query));
      const genres = isObject(raw) ? list(raw.genres) : [];
      res.json(genres.flatMap((genre) => (isObject(genre) && typeof genre.id === 'number' && typeof genre.name === 'string' ? [{ id: genre.id, name: genre.name, backdrops: [] }] : [])));
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  const details = (mediaType: MediaType): RequestHandler => async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return fail(res, 404, 'Not found.');
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const raw = await deps.tmdb.detailsRaw(mediaType, id, languageOf(req.query));
      if (!isObject(raw)) return fail(res, 503, 'TMDB is not available.');
      res.json(mediaType === 'movie' ? movieDetailsOf(raw) : tvDetailsOf(raw));
    } catch (error) {
      tmdbFailure(res, error);
    }
  };

  router.get('/movie/:id', details('movie'));
  router.get('/tv/:id', details('tv'));
  router.get('/movie/:id/ratings', (_req, res) => void res.json({}));
  router.get('/tv/:id/ratings', (_req, res) => void res.json({}));

  const related = (mediaType: MediaType, kind: 'similar' | 'recommendations'): RequestHandler => async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return fail(res, 404, 'Not found.');
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const page = Number(pageOf(req.query.page));
      const language = languageOf(req.query);
      const raw = kind === 'similar' ? await deps.tmdb.similar(mediaType, id, page, language) : await deps.tmdb.recommendationsPage(mediaType, id, page, language);
      res.json(pageResource(raw, mediaType));
    } catch (error) {
      tmdbFailure(res, error);
    }
  };

  router.get('/movie/:id/similar', related('movie', 'similar'));
  router.get('/movie/:id/recommendations', related('movie', 'recommendations'));
  router.get('/tv/:id/similar', related('tv', 'similar'));
  router.get('/tv/:id/recommendations', related('tv', 'recommendations'));

  router.get('/person/:id/combined_credits', async (req, res) => {
    const id = positiveId(req.params.id);
    if (!id) return fail(res, 404, 'Not found.');
    if (!deps.tmdb) return tmdbMissing(res);
    try {
      const raw = await deps.tmdb.personCredits(id, languageOf(req.query));
      const data = isObject(raw) ? raw : {};
      res.json({ id, cast: list(data.cast).map((item) => personCreditOf(item)), crew: list(data.crew).map((item) => personCreditOf(item)) });
    } catch (error) {
      tmdbFailure(res, error);
    }
  });

  router.get('/request', (_req, res) => {
    const records = Object.values(db.data.seerr.requests).sort((a, b) => b.id - a.id);
    res.json({ pageInfo: { page: 1, pages: 1, results: records.length }, results: records.map((record) => requestResource(record)) });
  });

  router.post('/request', async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const mediaType = body.mediaType;
    const tmdbId = typeof body.mediaId === 'number' ? body.mediaId : undefined;
    if (mediaType !== 'movie' && mediaType !== 'tv') return fail(res, 400, 'The media type must be movie or tv.');
    if (!Number.isInteger(tmdbId) || (tmdbId as number) < 1) return fail(res, 400, 'The media ID must be a whole number from 1.');
    if (body.is4k === true) return fail(res, 400, '4K requests are not supported.');
    const seasons = readSeasonList(body.seasons);
    if (seasons === null) return fail(res, 400, 'The seasons must be a list of numbers.');

    const key = `${mediaType}:${(tmdbId as number)}`;
    let title = db.data.titles[key];
    let created = false;

    if (!title) {
      if (!deps.tmdb) return tmdbMissing(res);
      let meta;
      try {
        meta = await deps.tmdb.details(mediaType, tmdbId as number);
      } catch (error) {
        if (error instanceof TmdbError && error.code === 'not_found') return fail(res, 400, 'The media does not exist.');
        return tmdbFailure(res, error);
      }
      const root = rootOf(mediaType);
      if (!root) return fail(res, 400, 'No root folder is set for this media type.');
      const requested = mediaType === 'tv' ? (seasons.length ? seasons : meta.seasons.map((season) => season.seasonNumber).filter((season) => season !== 0)) : [];
      const overrides: Title['seasonOverrides'] = {};
      for (const season of meta.seasons) overrides[season.seasonNumber] = requested.includes(season.seasonNumber) ? 'monitored' : 'unmonitored';
      try {
        ({ title } = await addTitle(
          { tmdb: deps.tmdb, enqueue: deps.enqueue },
          { mediaType, tmdbId: tmdbId as number, mode: 'all', seriesType: 'standard', preset: firstProfileId(), rootId: root.id, seasonOverrides: overrides, meta },
        ));
      } catch (error) {
        if (error instanceof AddError) title = db.data.titles[key];
        else return tmdbFailure(res, error);
      }
      if (title) {
        created = true;
        deps.enqueue({ type: 'queue.initial', payload: { key }, dedupeKey: `initial:${key}` });
      }
    }

    if (!title) return fail(res, 500, 'The title was not added.');
    const requested = requestedSeasons(title, seasons);
    applySeasons(title, requested);

    let complete = false;
    if (mediaType === 'tv') {
      complete = requested.length > 0 && requested.every((season) => seasonStatus(title!, season) === AVAILABLE);
      if (!complete) title.paused = false;
    } else {
      complete = Boolean(presentFile(title.fileId));
      if (!complete) title.paused = false;
    }

    if (!created && !complete && deps.services && (mediaType === 'movie' || title.episodesLoadedAt)) {
      deps.services.finder.requestSearch(title.key, { reason: 'requested in Seerr', fresh: true });
    }

    const existing = requestsFor(mediaType, tmdbId as number)[0];
    const now = Date.now();
    let record: SeerrRequest;
    if (existing) {
      existing.seasons = requested;
      existing.updatedAt = now;
      record = existing;
    } else {
      record = { id: ++db.data.seerr.requestSeq, mediaType, tmdbId: tmdbId as number, seasons: requested, createdAt: now, updatedAt: now };
      db.data.seerr.requests[record.id] = record;
    }
    await db.write();
    deps.events.publish('library.changed', { key });
    res.status(201).json(requestResource(record));
  });

  router.put('/request/:id', unsupported('A request cannot be updated.'));
  router.delete('/request/:id', unsupported('A request cannot be deleted.'));

  router.use(seerrNotFound);
  return router;
}

export type SeerrOptions = CompatDeps & { restorer?: Restorer };

// The Seerr API on port 5055. A caller adds /api/v1, as with Seerr.
export function seerr(options: SeerrOptions) {
  const { restorer, ...deps } = options;
  const app = express();
  app.disable('x-powered-by');
  app.use(express.json({ limit: '100kb' }));
  if (restorer) app.use(restoreGate(restorer));
  app.use('/api/v1', seerrRouter(deps), onError);
  app.use((_req, res) => fail(res, 404, 'Use /api/v1.'));
  return app;
}
