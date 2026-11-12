import type { SearchResult } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { type Db, db } from '../core/db.ts';
import { availability, titleKey } from '../library/library.ts';
import { clock } from '../library/tools/api.ts';
import { queueStatusOf } from '../library/tools/queue-status.ts';
import { TmdbError, type Tmdb } from '../metadata/tmdb.ts';

// The newest title comes first. A title with no year is not known to be new, so it goes last.
export const newestFirst = (results: SearchResult[]) =>
  [...results].sort((a, b) => (b.year ?? Number.MIN_SAFE_INTEGER) - (a.year ?? Number.MIN_SAFE_INTEGER));

// Marks the results that are in the library already, with the state that the bookmark of the poster shows.
export function inLibrary() {
  return (results: SearchResult[]): SearchResult[] => {
    const at = clock();
    return results.map(({ mediaType, tmdbId, title, year, overview, posterPath, originalLanguage }) => {
      const library = db.data.titles[titleKey(mediaType, tmdbId)];
      return {
        mediaType,
        tmdbId,
        title,
        year,
        overview,
        posterPath,
        originalLanguage,
        libraryKey: library?.key ?? null,
        seriesType: mediaType === 'tv' ? (library?.seriesType ?? null) : null,
        queueStatus: library ? queueStatusOf(library.key) : null,
        availability: library ? availability(library, at) : null,
      };
    });
  };
}

export function notFoundAsEmpty(err: unknown): undefined {
  if (err instanceof TmdbError && err.code === 'not_found') return undefined;
  throw err;
}

export const searchTarget =
  (tmdb: Tmdb | undefined): RequestHandler<{ mediaType: string; tmdbId: string }> =>
  (req, res, next) => {
    const { mediaType, tmdbId } = req.params;
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !/^[1-9]\d*$/.test(tmdbId)) return void res.status(404).json({ error: 'not_found' });
    res.locals.target = { mediaType, id: Number(tmdbId) };
    next();
  };
