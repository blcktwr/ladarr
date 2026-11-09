import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../../metadata/tmdb.ts';

export function searchCast(tmdb: Tmdb | undefined): RequestHandler {
  return async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    res.json({ cast: await tmdb!.cast(mediaType, id) });
  };
}
