import type { MediaType } from '@ladarr/shared/enums';
import type { CastMember, PersonCredits, SearchResult } from '@ladarr/shared/types';
import { outboundFetch } from '../core/http.ts';
import { JobError } from '../core/jobs.ts';

export type { CastMember, MediaType, PersonCredits, SearchResult };
export type ReleaseKind = 'premiere' | 'theatrical_limited' | 'theatrical' | 'digital' | 'physical' | 'tv';


export type ReleaseDate = { region: string; kind: ReleaseKind; date: string };
export type SeasonSummary = { seasonNumber: number; episodeCount: number; airDate: string | null };

// One page of a discover list, with the number of pages that TMDB has.
export type DiscoverPage = { results: SearchResult[]; totalPages: number };

// The TMDB facts about a title. A refresh replaces all of it, so it never holds a choice of the user.
export type TitleMeta = SearchResult & {
  originalTitle: string;
  aliases: string[];
  // The ISO 3166-1 regions that returned each alias. A title from an older version has no map.
  aliasRegions?: Record<string, string[]>;
  date: string | null;
  status: string;
  rating: number | null;
  votes: number;
  backdropPath: string | null;
  runtime: number | null;
  imdbId: string | null;
  tvdbId: number | null;
  releaseDates: ReleaseDate[];
  seasons: SeasonSummary[];
};

// A date-only air date stays a date. The caller uses UTC.
// shortcut: no episode overview, to keep the database file small. Fetch it on demand if the UI needs it.
export type EpisodeMeta = {
  tmdbId: number;
  season: number;
  number: number;
  name: string;
  airDate: string | null;
  runtime: number | null;
};

// TMDB numbers its release types from 1.
const RELEASE_KINDS: ReleaseKind[] = ['premiere', 'theatrical_limited', 'theatrical', 'digital', 'physical', 'tv'];

type ErrorCode = 'not_found' | 'invalid_key' | 'rate_limited' | 'unavailable';

// The message never holds the URL, because the URL holds the API key.
export class TmdbError extends JobError {
  code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(code === 'not_found' ? 'invalid_input' : 'outage', message);
    this.code = code;
  }
}

type Options = {
  apiKey: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
  // Least time between the starts of two requests. TMDB limits at about 40 requests a second.
  spacingMs?: number;
  ttlMs?: number;
};

const MAX_CACHED = 500;
const MAX_CAST = 12;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// The answers of TMDB are outside data, so these helpers read them without trusting their shape.
type Raw = any;
const text = (value: unknown) => (typeof value === 'string' ? value : '');
const textOrNull = (value: unknown) => text(value) || null;
const numberOrNull = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) ? value : null);
const yearOf = (date: string | null) => (date && /^\d{4}-/.test(date) ? Number(date.slice(0, 4)) : null);
const list = (value: unknown): Raw[] => (Array.isArray(value) ? value : []);

function searchResult(raw: Raw, mediaType: MediaType): SearchResult {
  const id = numberOrNull(raw?.id);
  if (id === null) throw new TmdbError('unavailable', 'TMDB sent an answer without an ID');
  const date = textOrNull(mediaType === 'movie' ? raw.release_date : raw.first_air_date);
  return {
    mediaType,
    tmdbId: id,
    title: text(mediaType === 'movie' ? raw.title : raw.name),
    year: yearOf(date),
    overview: text(raw.overview),
    posterPath: textOrNull(raw.poster_path),
    originalLanguage: text(raw.original_language),
  };
}

function titleMeta(raw: Raw, mediaType: MediaType): TitleMeta {
  const base = searchResult(raw, mediaType);
  const date = textOrNull(mediaType === 'movie' ? raw.release_date : raw.first_air_date);
  const originalTitle = text(mediaType === 'movie' ? raw.original_title : raw.original_name);
  const names = mediaType === 'movie' ? list(raw.alternative_titles?.titles) : list(raw.alternative_titles?.results);
  const aliases = [...new Set([originalTitle, ...names.map((alias) => text(alias?.title))])].filter((alias) => alias && alias !== base.title);
  const regions = new Map<string, Set<string>>();
  for (const alias of names) {
    const title = text(alias?.title);
    const region = text(alias?.iso_3166_1);
    if (!title || !region) continue;
    const known = regions.get(title) ?? new Set<string>();
    known.add(region);
    regions.set(title, known);
  }
  const aliasRegions = Object.fromEntries([...regions].map(([title, known]) => [title, [...known]]));
  const votes = numberOrNull(raw.vote_count) ?? 0;
  const ids = raw.external_ids ?? {};
  const runtime = mediaType === 'movie' ? raw.runtime : (raw.episode_run_time?.[0] ?? raw.last_episode_to_air?.runtime);

  return {
    ...base,
    originalTitle,
    aliases,
    aliasRegions,
    date,
    status: text(raw.status),
    rating: votes > 0 ? numberOrNull(raw.vote_average) : null,
    votes,
    backdropPath: textOrNull(raw.backdrop_path),
    // TMDB reports 0 for an unknown runtime.
    runtime: numberOrNull(runtime) || null,
    imdbId: textOrNull(ids.imdb_id ?? raw.imdb_id),
    tvdbId: numberOrNull(ids.tvdb_id),
    releaseDates: list(raw.release_dates?.results).flatMap((region) =>
      list(region?.release_dates).flatMap((entry) => {
        const kind = RELEASE_KINDS[Number(entry?.type) - 1];
        const when = textOrNull(entry?.release_date);
        return kind && when ? [{ region: text(region.iso_3166_1), kind, date: when }] : [];
      }),
    ),
    seasons: list(raw.seasons).map((season) => ({
      seasonNumber: numberOrNull(season?.season_number) ?? 0,
      episodeCount: numberOrNull(season?.episode_count) ?? 0,
      airDate: textOrNull(season?.air_date),
    })),
  };
}

export function createTmdb({
  apiKey,
  fetch: fetchImpl = fetch,
  baseUrl = 'https://api.themoviedb.org/3',
  timeoutMs = 10_000,
  spacingMs = 40,
  ttlMs = 5 * 60_000,
}: Options) {
  const send = outboundFetch('TMDB', fetchImpl);
  const cache = new Map<string, { at: number; value: unknown }>();
  const pending = new Map<string, Promise<unknown>>();
  let nextStart = 0;
  // Null until a request ends. The last request decides, so the state follows the provider.
  let health: { error: TmdbError | null } | null = null;

  async function request(path: string, params: Record<string, string>): Promise<unknown> {
    // The slot is taken in one step, so concurrent callers queue in order.
    const wait = Math.max(0, nextStart - Date.now());
    nextStart = Date.now() + wait + spacingMs;
    if (wait > 0) await sleep(wait);

    const url = new URL(baseUrl + path);
    url.search = new URLSearchParams({ ...params, api_key: apiKey }).toString();
    let res: Response;
    try {
      res = await send(url, { signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      throw new TmdbError('unavailable', `TMDB did not answer ${path}`);
    }
    if (res.status === 429) {
      nextStart = Date.now() + (Number(res.headers.get('retry-after')) || 2) * 1000;
      throw new TmdbError('rate_limited', 'TMDB limits the requests');
    }
    if (res.status === 404) throw new TmdbError('not_found', `TMDB has no ${path}`);
    if (res.status === 401 || res.status === 403) throw new TmdbError('invalid_key', 'TMDB rejects the API key');
    if (!res.ok) throw new TmdbError('unavailable', `TMDB answered ${res.status} for ${path}`);
    try {
      return await res.json();
    } catch {
      throw new TmdbError('unavailable', `TMDB sent an unreadable answer for ${path}`);
    }
  }

  // Equal requests that run at the same time share one call. An old answer stands in while TMDB is down.
  function get(path: string, params: Record<string, string> = {}, ttl = ttlMs): Promise<unknown> {
    const key = `${path}?${new URLSearchParams(Object.entries(params).sort())}`;
    const hit = cache.get(key);
    if (hit && Date.now() - hit.at < ttl) return Promise.resolve(hit.value);
    let call = pending.get(key);
    if (!call) {
      call = request(path, params)
        .then(
          (value) => {
            health = { error: null };
            cache.delete(key);
            cache.set(key, { at: Date.now(), value });
            if (cache.size > MAX_CACHED) cache.delete(cache.keys().next().value!);
            return value;
          },
          (error: TmdbError) => {
            // A 404 shows that TMDB answers and accepts the key.
            health = { error: error.code === 'not_found' ? null : error };
            // A call that asks for fresh data (ttl 0) must see the failure, so a refresh never saves old data as new.
            if (hit && ttl > 0 && (error.code === 'unavailable' || error.code === 'rate_limited')) return hit.value;
            throw error;
          },
        )
        .finally(() => pending.delete(key));
      pending.set(key, call);
    }
    return call;
  }

  // Pass ttl 0 to skip the cache.
  async function details(mediaType: MediaType, id: number, ttl = ttlMs): Promise<TitleMeta> {
    const append = mediaType === 'movie' ? 'release_dates,external_ids,alternative_titles' : 'external_ids,alternative_titles';
    return titleMeta(await get(`/${mediaType}/${id}`, { append_to_response: append }, ttl), mediaType);
  }

  // ok is null before the first request.
  const status = () => ({ ok: health ? health.error === null : null, code: health?.error?.code });

  return {
    status,

    // One request that shows whether TMDB answers and accepts the key.
    async check() {
      await get('/configuration', {}, 0).catch(() => {});
      return status();
    },

    // shortcut: only the first page of results, 20 at most. Add paging if people need more.
    async search(query: string): Promise<SearchResult[]> {
      const raw = (await get('/search/multi', { query, include_adult: 'false' }, 10 * 60_000)) as Raw;
      return list(raw?.results).flatMap((item) =>
        item?.media_type === 'movie' || item?.media_type === 'tv' ? [searchResult(item, item.media_type)] : [],
      );
    },

    // The titles of a discover list, in the order of TMDB.
    async discoverResults(mediaType: MediaType, params: Record<string, string> = {}): Promise<DiscoverPage> {
      const raw = (await get(`/discover/${mediaType}`, params)) as Raw;
      return { results: list(raw?.results).map((item) => searchResult(item, mediaType)), totalPages: numberOrNull(raw?.total_pages) ?? 1 };
    },

    // The raw TMDB methods below serve the Seerr compatibility API. They return the TMDB answer as it is.
    searchPage(query: string, page = 1, language?: string): Promise<unknown> {
      return get('/search/multi', { query, page: String(page), include_adult: 'false', ...(language ? { language } : {}) }, 10 * 60_000);
    },

    discover(mediaType: MediaType, params: Record<string, string>): Promise<unknown> {
      return get(`/discover/${mediaType}`, params);
    },

    trending(mediaType: 'all' | MediaType, window: 'day' | 'week', page = 1, language?: string): Promise<unknown> {
      return get(`/trending/${mediaType}/${window}`, { page: String(page), ...(language ? { language } : {}) });
    },

    detailsRaw(mediaType: MediaType, id: number, language?: string): Promise<unknown> {
      const append = mediaType === 'movie' ? 'credits,external_ids,videos,release_dates,alternative_titles' : 'credits,external_ids,videos,content_ratings,alternative_titles';
      return get(`/${mediaType}/${id}`, { append_to_response: append, ...(language ? { language } : {}) });
    },

    similar(mediaType: MediaType, id: number, page = 1, language?: string): Promise<unknown> {
      return get(`/${mediaType}/${id}/similar`, { page: String(page), ...(language ? { language } : {}) });
    },

    recommendationsPage(mediaType: MediaType, id: number, page = 1, language?: string): Promise<unknown> {
      return get(`/${mediaType}/${id}/recommendations`, { page: String(page), ...(language ? { language } : {}) });
    },

    personCredits(id: number, language?: string): Promise<unknown> {
      return get(`/person/${id}/combined_credits`, language ? { language } : {});
    },

    genres(mediaType: MediaType, language?: string): Promise<unknown> {
      return get(`/genre/${mediaType}/list`, language ? { language } : {});
    },

    // Every series that has this TVDB ID. The caller must ask for a match unless exactly one comes back.
    async findSeriesByTvdb(tvdbId: number): Promise<SearchResult[]> {
      const raw = (await get(`/find/${tvdbId}`, { external_source: 'tvdb_id' })) as Raw;
      return list(raw?.tv_results).map((item) => searchResult(item, 'tv'));
    },

    details,

    // The first actors of the credits, in the order of TMDB. The caller does not store them.
    async cast(mediaType: MediaType, id: number): Promise<CastMember[]> {
      const raw = (await get(`/${mediaType}/${id}/credits`)) as Raw;
      return list(raw?.cast)
        .flatMap((person) => {
          const personId = numberOrNull(person?.id);
          return personId === null ? [] : [{ id: personId, name: text(person.name), character: text(person.character), profilePath: textOrNull(person.profile_path) }];
        })
        .slice(0, MAX_CAST);
    },

    // An actor with every movie and series in the credits. A title with more than one credit shows once. The newest title is first, and a title with no date is last.
    async person(id: number): Promise<PersonCredits> {
      const raw = (await get(`/person/${id}`, { append_to_response: 'combined_credits' })) as Raw;
      const personId = numberOrNull(raw?.id);
      if (personId === null) throw new TmdbError('unavailable', 'TMDB sent an answer without an ID');
      const dated = list(raw.combined_credits?.cast)
        .filter((item) => item?.media_type === 'movie' || item?.media_type === 'tv')
        .map((item) => ({ result: searchResult(item, item.media_type), date: text(item.media_type === 'movie' ? item.release_date : item.first_air_date) }))
        .sort((a, b) => b.date.localeCompare(a.date));
      const credits = new Map(dated.map(({ result }) => [`${result.mediaType}:${result.tmdbId}`, result]));
      return { person: {
          id: personId,
          name: text(raw.name),
          profilePath: textOrNull(raw.profile_path),
          alsoKnownAs: list(raw.also_known_as).map(text).filter(Boolean),
          popularity: numberOrNull(raw.popularity),
        }, credits: [...credits.values()] };
    },

    // shortcut: only the first page of results, 20 at most. Add paging if people need more.
    async recommendations(mediaType: MediaType, id: number): Promise<SearchResult[]> {
      const raw = (await get(`/${mediaType}/${id}/recommendations`)) as Raw;
      return list(raw?.results).map((item) => searchResult(item, mediaType));
    },

    async season(seriesId: number, seasonNumber: number, ttl = ttlMs): Promise<EpisodeMeta[]> {
      const raw = (await get(`/tv/${seriesId}/season/${seasonNumber}`, {}, ttl)) as Raw;
      return list(raw?.episodes).flatMap((episode) => {
        const id = numberOrNull(episode?.id);
        const number = numberOrNull(episode?.episode_number);
        if (id === null || number === null) return [];
        return [
          {
            tmdbId: id,
            season: seasonNumber,
            number,
            name: text(episode.name),
            airDate: textOrNull(episode.air_date),
            runtime: numberOrNull(episode.runtime) || null,
          },
        ];
      });
    },
  };
}

export type Tmdb = ReturnType<typeof createTmdb>;
