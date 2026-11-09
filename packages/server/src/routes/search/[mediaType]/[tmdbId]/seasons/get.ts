import type { SeriesEpisodes } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../../metadata/tmdb.ts';

// Every episode of every season of a series, for the page of a title that is not in the library.
// A season with no episodes is not there.
export function searchSeasons(tmdb: Tmdb | undefined): RequestHandler {
  return async (_req, res) => {
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
  };
}
