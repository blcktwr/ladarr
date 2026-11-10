import { get } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../../metadata/tmdb.ts';
import { inLibrary } from '../../../../../helpers/search.ts';

export function searchRecommendations(tmdb: Tmdb | undefined): RequestHandler {
  const db = get();
  return async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    res.json({ results: inLibrary(db)(await tmdb!.recommendations(mediaType, id)) });
  };
}
