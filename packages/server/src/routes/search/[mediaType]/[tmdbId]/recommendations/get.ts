import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../../metadata/tmdb.ts';
import { inLibrary } from '../../../../../helpers/search.ts';

export function searchRecommendations(tmdb: Tmdb | undefined): RequestHandler {
  return async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    res.json({ results: inLibrary()(await tmdb!.recommendations(mediaType, id)) });
  };
}
