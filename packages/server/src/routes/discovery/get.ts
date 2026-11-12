import type { DiscoveryGenre, DiscoveryPage, DiscoveryRow, DiscoverySort } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { inLibrary } from '../../helpers/search.ts';
import type { MediaType, Tmdb } from '../../metadata/tmdb.ts';
import { discoveryGenres } from './genres.ts';

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

const regionOf = (value: unknown) => {
  const code = typeof value === 'string' ? value.toUpperCase() : '';
  return REGION.test(code) ? code : undefined;
};

const providersOf = (value: unknown) =>
  typeof value === 'string' ? value.split(',').flatMap((id) => (/^\d+$/.test(id) ? [id] : [])) : [];

// The lists of the discovery page, in the order of the page. A filter that the page does not know is left out.
export function discoveryGet(tmdb: Tmdb | undefined): RequestHandler {
  const map = inLibrary();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const requested = Number(req.query.page);
    const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
    const sort = SORTS[sortOf(req.query.sort)];
    const from = dateOf(req.query.from);
    const to = dateOf(req.query.to);
    const region = regionOf(req.query.region);
    // A watch provider needs the country of its list.
    const providers = region ? providersOf(req.query.providers) : [];
    const genreName = typeof req.query.genre === 'string' ? req.query.genre : '';
    let genre: DiscoveryGenre | undefined;
    if (genreName) {
      const [movieGenres, seriesGenres] = await Promise.all([tmdb.genreList('movie'), tmdb.genreList('tv')]);
      genre = discoveryGenres(movieGenres, seriesGenres).find((item) => item.name === genreName);
    }
    const params = (mediaType: MediaType): Record<string, string> => ({
      sort_by: sort[mediaType],
      page: String(page),
      ...(from ? { [mediaType === 'movie' ? 'primary_release_date.gte' : 'first_air_date.gte']: from } : {}),
      ...(to ? { [mediaType === 'movie' ? 'primary_release_date.lte' : 'first_air_date.lte']: to } : {}),
      ...(genre?.[mediaType] ? { with_genres: String(genre[mediaType]) } : {}),
      ...(providers.length ? { with_watch_providers: providers.join('|'), watch_region: region } : {}),
    });
    const [movies, series] = await Promise.all([
      tmdb.discoverResults('movie', params('movie')),
      tmdb.discoverResults('tv', params('tv')),
    ]);
    const rows: DiscoveryRow[] = [
      { id: 'movies', results: map(movies.results) },
      { id: 'series', results: map(series.results) },
    ];
    const body: DiscoveryPage = { page, totalPages: Math.max(movies.totalPages, series.totalPages), rows };
    res.json(body);
  };
}
