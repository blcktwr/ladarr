import type { SearchResult } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { inLibrary, MAX_QUERY, newestFirst, searchById } from '../../helpers/search.ts';
import type { Tmdb } from '../../types.ts';

// Finds titles by name, by a bare TMDB ID, by `tmdb:<id>` with a media type, or by `tvdb:<id>` for a series.
export function searchGet(tmdb: Tmdb | undefined): RequestHandler {
  const map = inLibrary();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query || query.length > MAX_QUERY) return void res.status(400).json({ error: 'invalid_query' });

    const typed = /^tmdb:\d+$/i.test(query);
    const type = req.query.type === 'movie' || req.query.type === 'tv' ? req.query.type : undefined;
    if (typed && !type) return void res.status(400).json({ error: 'media_type_required' });
    const match = await searchById<SearchResult>(query, typed ? type : undefined, tmdb);
    res.json({ ...match, results: map(newestFirst(match?.results ?? await tmdb.search(query))) });
  };
}
