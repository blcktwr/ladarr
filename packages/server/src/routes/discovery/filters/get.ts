import type { DiscoveryFilters } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../metadata/tmdb.ts';
import { discoveryGenres } from '../genres.ts';

// The lists of the filter panel: the genres of both media types and the countries of the watch providers.
export function discoveryFiltersGet(tmdb: Tmdb | undefined): RequestHandler {
  return async (_req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const [movies, series, regions] = await Promise.all([tmdb.genreList('movie'), tmdb.genreList('tv'), tmdb.watchRegions()]);
    const body: DiscoveryFilters = { genres: discoveryGenres(movies, series), regions };
    res.json(body);
  };
}
