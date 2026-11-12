import type { DiscoveryPage, DiscoveryRow, DiscoverySort } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { inLibrary } from '../../helpers/search.ts';
import type { Tmdb } from '../../metadata/tmdb.ts';

// The field of TMDB that orders each list. A movie and a series name their release date in different fields.
const SORTS: Record<DiscoverySort, { movie: string; tv: string }> = {
  'popularity.asc': { movie: 'popularity.asc', tv: 'popularity.asc' },
  'popularity.desc': { movie: 'popularity.desc', tv: 'popularity.desc' },
  'release.asc': { movie: 'primary_release_date.asc', tv: 'first_air_date.asc' },
  'release.desc': { movie: 'primary_release_date.desc', tv: 'first_air_date.desc' },
  'rating.asc': { movie: 'vote_average.asc', tv: 'vote_average.asc' },
  'rating.desc': { movie: 'vote_average.desc', tv: 'vote_average.desc' },
};

// The sort of the query. A sort that the page does not know is the order of popularity.
const sortOf = (value: unknown): DiscoverySort =>
  typeof value === 'string' && value in SORTS ? (value as DiscoverySort) : 'popularity.desc';

// The lists of the discovery page, in the order of the page.
export function discoveryGet(tmdb: Tmdb | undefined): RequestHandler {
  const map = inLibrary();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const requested = Number(req.query.page);
    const page = Number.isInteger(requested) && requested > 0 ? requested : 1;
    const sort = SORTS[sortOf(req.query.sort)];
    const [movies, series] = await Promise.all([
      tmdb.discoverResults('movie', { sort_by: sort.movie, page: String(page) }),
      tmdb.discoverResults('tv', { sort_by: sort.tv, page: String(page) }),
    ]);
    const rows: DiscoveryRow[] = [
      { id: 'movies', results: map(movies.results) },
      { id: 'series', results: map(series.results) },
    ];
    const body: DiscoveryPage = { page, totalPages: Math.max(movies.totalPages, series.totalPages), rows };
    res.json(body);
  };
}
