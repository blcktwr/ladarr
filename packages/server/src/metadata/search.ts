import { Router } from 'express';
import type { PersonCredits, SearchResult, SeriesEpisodes, TitlePreview } from '@ladarr/shared/types';
import type { Db } from '../core/db.ts';
import { titleKey } from '../library/library.ts';
import { TmdbError, type MediaType, type Tmdb } from './tmdb.ts';

const MAX_QUERY = 200;

// The oldest title comes first. A title with no year is not known to be old, so it goes last.
const oldestFirst = (results: SearchResult[]) =>
  [...results].sort((a, b) => (a.year ?? Number.MAX_SAFE_INTEGER) - (b.year ?? Number.MAX_SAFE_INTEGER));

// Finds titles by name, or by `tmdb:<id>` with a media type, or by `tvdb:<id>` for a series.
export function searchRouter(tmdb: Tmdb | undefined, db: Db) {
  const router = Router();
  // Marks the results that are in the library already.
  const inLibrary = (results: SearchResult[]): SearchResult[] =>
    results.map(({ mediaType, tmdbId, title, year, overview, posterPath, originalLanguage }) => {
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
      };
    });

  router.get('/', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const query = typeof req.query.query === 'string' ? req.query.query.trim() : '';
    if (!query || query.length > MAX_QUERY) return void res.status(400).json({ error: 'invalid_query' });

    const byTmdb = /^tmdb:(\d+)$/i.exec(query);
    if (byTmdb) {
      const type = req.query.type === 'movie' || req.query.type === 'tv' ? (req.query.type as MediaType) : undefined;
      if (!type) return void res.status(400).json({ error: 'media_type_required' });
      const found = await tmdb.details(type, Number(byTmdb[1])).catch(notFoundAsEmpty);
      return void res.json({ results: inLibrary(found ? [found] : []) });
    }

    const byTvdb = /^tvdb:(\d+)$/i.exec(query);
    if (byTvdb) {
      const results = oldestFirst(await tmdb.findSeriesByTvdb(Number(byTvdb[1])).catch((err) => notFoundAsEmpty(err) ?? []));
      // The caller must pick a match unless exactly one series has this ID.
      return void res.json({ results: inLibrary(results), needsMatch: results.length !== 1 });
    }

    res.json({ results: inLibrary(oldestFirst(await tmdb.search(query))) });
  });

  router.get('/person/:id', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    if (!/^[1-9]\d*$/.test(req.params.id!)) return void res.status(404).json({ error: 'not_found' });
    const { person, credits } = await tmdb.person(Number(req.params.id));
    res.json({ person, credits: inLibrary(credits) } satisfies PersonCredits);
  });

  // The page of a title asks for these, whether the title is in the library or not. TMDB sends them when the page asks, so the database does not hold them.
  router.use('/:mediaType/:tmdbId', (req, res, next) => {
    const { mediaType, tmdbId } = req.params;
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    if ((mediaType !== 'movie' && mediaType !== 'tv') || !/^[1-9]\d*$/.test(tmdbId!)) return void res.status(404).json({ error: 'not_found' });
    res.locals.target = { mediaType, id: Number(tmdbId) };
    next();
  });

  router.get('/:mediaType/:tmdbId', async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    const meta = await tmdb!.details(mediaType, id);
    res.json({
      title: {
        ...inLibrary([meta])[0],
        backdropPath: meta.backdropPath,
        rating: meta.rating,
        runtime: meta.runtime,
        imdbId: meta.imdbId,
        tvdbId: meta.tvdbId,
        providerStatus: meta.status,
      } satisfies TitlePreview,
    });
  });

  // Every episode of every season of a series, for the page of a title that is not in the library.
  // A season with no episodes is not there.
  router.get('/:mediaType/:tmdbId/seasons', async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    if (mediaType !== 'tv') return void res.status(404).json({ error: 'not_found' });
    const { seasons } = await tmdb!.details(mediaType, id);
    const loaded = await Promise.all(
      seasons
        .filter((season) => season.episodeCount > 0)
        .map(async (season) => ({
          seasonNumber: season.seasonNumber,
          episodes: (await tmdb!.season(id, season.seasonNumber)).map(({ season: seasonNumber, number, name, airDate, runtime }) => ({ season: seasonNumber, number, name, airDate, runtime })),
        })),
    );
    res.json({ seasons: loaded } satisfies SeriesEpisodes);
  });

  router.get('/:mediaType/:tmdbId/cast', async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    res.json({ cast: await tmdb!.cast(mediaType, id) });
  });

  router.get('/:mediaType/:tmdbId/recommendations', async (_req, res) => {
    const { mediaType, id } = res.locals.target;
    res.json({ results: inLibrary(await tmdb!.recommendations(mediaType, id)) });
  });

  return router;
}

function notFoundAsEmpty(err: unknown): undefined {
  if (err instanceof TmdbError && err.code === 'not_found') return undefined;
  throw err;
}
