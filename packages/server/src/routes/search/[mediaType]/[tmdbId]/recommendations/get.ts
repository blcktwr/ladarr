import type { RequestHandler } from 'express';
import type { Db } from '../../../../../core/db.ts';
import type { Tmdb } from '../../../../../metadata/tmdb.ts';
import { inLibrary } from '../../../../../helpers/search.ts';

export function searchRecommendations(tmdb: Tmdb | undefined, db: Db): RequestHandler {
  return async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    res.json({ results: inLibrary(db)(await tmdb!.recommendations(mediaType, id)) });
  };
}
