import { db } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import type { MediaType, Tmdb } from '../../metadata/tmdb.ts';
import { inLibrary, notFoundAsEmpty, newestFirst } from '../../helpers/search.ts';

const MAX_QUERY = 200;

// Finds titles by name, or by `tmdb:<id>` with a media type, or by `tvdb:<id>` for a series.
export function searchGet(tmdb: Tmdb | undefined): RequestHandler {
  const map = inLibrary();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query || query.length > MAX_QUERY) return void res.status(400).json({ error: 'invalid_query' });

    const byTmdb = /^tmdb:(\d+)$/i.exec(query);
    if (byTmdb) {
      const type = req.query.type === 'movie' || req.query.type === 'tv' ? (req.query.type as MediaType) : undefined;
      if (!type) return void res.status(400).json({ error: 'media_type_required' });
      const found = await tmdb.details(type, Number(byTmdb[1])).catch(notFoundAsEmpty);
      return void res.json({ results: map(found ? [found] : []) });
    }

    const byTvdb = /^tvdb:(\d+)$/i.exec(query);
    if (byTvdb) {
      const results = newestFirst(await tmdb.findSeriesByTvdb(Number(byTvdb[1])).catch((err) => notFoundAsEmpty(err) ?? []));
      // The caller must pick a match unless exactly one series has this ID.
      return void res.json({ results: map(results), needsMatch: results.length !== 1 });
    }

    res.json({ results: map(newestFirst(await tmdb.search(query))) });
  };
}
