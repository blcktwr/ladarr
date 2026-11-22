import type { SearchResult } from '@ladarr/shared/types';
import type { MediaType } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import { db } from '../core/db.ts';
import { availability, seriesCounts, titleKey } from '../library/library.ts';
import { clock } from '../library/tools/api.ts';
import { queueStatusOf } from '../library/tools/queue-status.ts';
import { TmdbError } from '../metadata/tmdb.ts';
import type { Db, Tmdb } from '../types.ts';

export const MAX_QUERY = 200;

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
        counts: library && mediaType === 'tv' ? seriesCounts(library, at) : null,
      };
    });
  };
}

function notFoundAsEmpty(err: unknown): undefined {
  if (err instanceof TmdbError && err.code === 'not_found') return undefined;
  throw err;
}

// A bare ID searches movies first. If neither media type has the ID, the caller searches by title.
export async function searchById<T>(query: string, type: MediaType | undefined, source: {
  details: (type: MediaType, id: number) => Promise<T>;
  findSeriesByTvdb: (id: number) => Promise<T[]>;
}): Promise<{ results: T[]; needsMatch?: boolean } | undefined> {
  const match = /^(?:(tmdb|tvdb):)?(\d+)$/i.exec(query);
  if (!match) return;
  const id = Number(match[2]);
  if (match[1]?.toLowerCase() === 'tvdb') {
    const results = await source.findSeriesByTvdb(id).catch((err) => notFoundAsEmpty(err) ?? []);
    return { results, needsMatch: results.length !== 1 };
  }
  for (const mediaType of type ? [type] : (['movie', 'tv'] as const)) {
    const found = await source.details(mediaType, id).catch(notFoundAsEmpty);
    if (found) return { results: [found] };
  }
  if (match[1]) return { results: [] };
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
