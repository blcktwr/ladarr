import { db } from '../../../../core/db.ts';
import type { EpisodeRow } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { episodeEligibleAt } from '../../../../core/dates.ts';
import { entryId, queueKey } from '../../../../library/downloads/queue.ts';
import { clock } from '../../../../library/tools/api.ts';
import { isMonitored, type Title } from '../../../../library/library.ts';

export function libraryEpisodes(): RequestHandler<{ key: string }> {
  return (req, res) => {
    const title: Title = res.locals.title;
    const season = Number(req.query.season);
    if (title.mediaType !== 'tv' || !Number.isInteger(season) || season < 0) return void res.status(400).json({ error: 'invalid_season' });
    const at = clock();
    const episodes: EpisodeRow[] = title.episodes
      .filter((episode) => episode.season === season)
      .map((episode) => {
        const airs = episodeEligibleAt(episode.airDate);
        const entry = db.data.queue[entryId(title.key, episode.season, episode.number)];
        return {
          season: episode.season,
          number: episode.number,
          name: episode.name,
          airDate: episode.airDate,
          runtime: episode.runtime,
          monitored: isMonitored(title, episode),
          override: episode.override,
          aired: airs !== null && airs <= at.now,
          hasFile: Boolean(episode.fileId && !at.files[episode.fileId]?.missing),
          queue: entry && entry.attempt > 0 && !entry.clearedAt ? queueKey(entry) : null,
        };
      });
    res.json({ season, episodes });
  };
}
