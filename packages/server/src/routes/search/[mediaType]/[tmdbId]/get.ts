import { db } from '../../../../core/db.ts';
import type { TitlePreview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../metadata/tmdb.ts';
import { inLibrary } from '../../../../helpers/search.ts';

export function searchTitle(tmdb: Tmdb | undefined): RequestHandler {
  return async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    const meta = await tmdb!.details(mediaType, id);
    res.json({
      title: {
        ...inLibrary()([meta])[0],
        date: meta.date,
        backdropPath: meta.backdropPath,
        rating: meta.rating,
        runtime: meta.runtime,
        genres: meta.genres ?? [],
        certification: meta.certification ?? null,
        imdbId: meta.imdbId,
        tvdbId: meta.tvdbId,
        providerStatus: meta.status,
      } satisfies TitlePreview,
    });
  };
}
