import type { DiscoveryGenre, DiscoveryPage, DiscoveryRow, DiscoverySort } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { inLibrary, MAX_QUERY, searchById } from '../../helpers/search.ts';
import { discoveryGenres } from './genres.ts';
import type { MediaType } from '@ladarr/shared/enums';
import type { Tmdb } from '../../types.ts';

// The field of TMDB that orders each list. A movie and a series name their release date in different fields.
const SORTS: Record<DiscoverySort, { movie: string; tv: string }> = {
  'popularity.asc': { movie: 'popularity.asc', tv: 'popularity.asc' },
  'popularity.desc': { movie: 'popularity.desc', tv: 'popularity.desc' },
  'release.asc': { movie: 'primary_release_date.asc', tv: 'first_air_date.asc' },
  'release.desc': { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  'rating.asc': { movie: 'vote_average.asc', tv: 'vote_average.asc' },
  'rating.desc': { movie: 'vote_average.desc', tv: 'vote_average.desc' },
};

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const REGION = /^[A-Z]{2}$/;

// The sort of the query. A sort that the page does not know is the order of popularity.
const sortOf = (value: unknown): DiscoverySort =>
  typeof value === 'string' && value in SORTS ? (value as DiscoverySort) : 'popularity.desc';

const dateOf = (value: unknown) => (typeof value === 'string' && DATE.test(value) ? value : undefined);

const ratingOf = (value: unknown, fallback: number) => {
  const rating = typeof value === 'string' && value.trim() ? Number(value) : fallback;
  return rating >= 0 && rating <= 10 ? rating : fallback;
};

const regionOf = (value: unknown) => {
  const code = typeof value === 'string' ? value.toUpperCase() : '';
  return REGION.test(code) ? code : undefined;
};

const providersOf = (value: unknown) =>
  typeof value === 'string' ? value.split(',').flatMap((id) => (/^\d+$/.test(id) ? [id] : [])) : [];

// The list that the page asks for. A type that the page does not know leaves the two lists in.
const typeOf = (value: unknown) => (value === 'movie' || value === 'tv' ? (value as MediaType) : undefined);

// The lists of the discovery page, in the order of the page. A filter that the page does not know is left out.
export function discoveryGet(tmdb: Tmdb | undefined): RequestHandler {
  const map = inLibrary();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const requested = Number(req.query.page);
    const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
    const order = sortOf(req.query.sort);
    const sort = SORTS[order];
    const query = typeof req.query.q === 'string' ? req.query.q.trim() : '';
    if (query.length > MAX_QUERY) return void res.status(400).json({ error: 'invalid_query' });
    const from = dateOf(req.query.from);
    const to = dateOf(req.query.to);
    const ratingMin = ratingOf(req.query.ratingMin, 0);
    const ratingMax = ratingOf(req.query.ratingMax, 10);
    const hasRating = ratingMin <= ratingMax && (ratingMin > 0 || ratingMax < 10);
    const region = regionOf(req.query.region);
    // A watch provider needs the country of its list.
    const providers = region ? providersOf(req.query.providers) : [];
    const genreName = typeof req.query.genre === 'string' ? req.query.genre : '';
    let genre: DiscoveryGenre | undefined;
    if (genreName) {
      const [movieGenres, seriesGenres] = await Promise.all([tmdb.genreList('movie'), tmdb.genreList('tv')]);
      genre = discoveryGenres(movieGenres, seriesGenres).find((item) => item.name === genreName);
    }
    const type = typeOf(req.query.type);
    const lists = type ? [type] : (['movie', 'tv'] as MediaType[]);
    if (query) {
      const source = tmdb.discoverySearch;
      const match = await searchById(query, type, source);
      const { results, totalPages } = match ? { results: page === 1 ? match.results : [], totalPages: 1 } : await source.page(query, page);
      const candidates = results.filter((item) => {
        const genreId = genre?.[item.mediaType];
        return (!type || item.mediaType === type) &&
          (!from || (item.date && item.date >= from)) && (!to || (item.date && item.date <= to)) &&
          (!hasRating || (item.rating !== null && item.rating > 0 && item.rating >= ratingMin && item.rating <= ratingMax)) &&
          (!genre || (genreId != null && item.genreIds.includes(genreId)));
      });
      // TMDB gives the watch providers per title. Only the titles that pass the other filters need this request.
      const matches = region && providers.length ? (await Promise.all(candidates.map(async (item) => {
        const services = await source.providers(item.mediaType, item.tmdbId, region);
        return services.some((id) => providers.includes(id)) ? item : null;
      }))).filter((item) => item !== null) : candidates;
      const direction = order.endsWith('.asc') ? 1 : -1;
      const rows: DiscoveryRow[] = lists.map((mediaType) => {
        const group = matches.filter((item) => item.mediaType === mediaType);
        const results = map(group).map((result, i) => {
          const { date, rating, popularity } = group[i]!;
          const value = order.startsWith('rating') ? rating : order.startsWith('popularity') ? popularity : date ? Date.parse(date) : null;
          return { ...result, sortKey: value === null ? null : direction * value };
        });
        return {
          id: mediaType === 'movie' ? 'movies' : 'series',
          results: results.sort((a, b) => (a.sortKey ?? Infinity) - (b.sortKey ?? Infinity)),
        };
      });
      return void res.json({ page, totalPages, rows, needsMatch: match?.needsMatch } satisfies DiscoveryPage);
    }
    const params = (mediaType: MediaType): Record<string, string> => ({
      sort_by: sort[mediaType],
      page: String(page),
      ...(from ? { [mediaType === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte']: from } : {}),
      ...(to ? { [mediaType === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte']: to } : {}),
      ...(hasRating ? { 'vote_count.gte': '1' } : {}),
      ...(hasRating && ratingMin > 0 ? { 'vote_average.gte': String(ratingMin) } : {}),
      ...(hasRating && ratingMax < 10 ? { 'vote_average.lte': String(ratingMax) } : {}),
      ...(genre?.[mediaType] ? { with_genres: String(genre[mediaType]) } : {}),
      ...(providers.length ? { with_watch_providers: providers.join('|'), watch_region: region } : {}),
    });
    const answers = await Promise.all(lists.map((mediaType) => tmdb.discoverResults(mediaType, params(mediaType))));
    const rows: DiscoveryRow[] = lists.map((mediaType, index) => ({
      id: mediaType === 'movie' ? 'movies' : 'series',
      results: map(answers[index]!.results),
    }));
    const body: DiscoveryPage = { page, totalPages: Math.max(...answers.map((answer) => answer.totalPages)), rows };
    res.json(body);
  };
}
