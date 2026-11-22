import { db } from '../../../../core/db.ts';
import type { EpisodeRow } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { episodeEligibleAt } from '../../../../core/dates.ts';
import { entryId } from '../../../../library/downloads/queue.ts';
import { clock } from '../../../../library/tools/api.ts';
import { statusOf } from '../../../../helpers/queue.ts';
import { seasonGroups } from '../../../../helpers/library.ts';
import { isMonitored } from '../../../../library/library.ts';
import type { Title } from '../../../../types.ts';

export function libraryEpisodes(): RequestHandler<{ key: string }> {
  return (req, res) => {
    const title: Title = res.locals.title;
    const season = Number(req.query.season);
    if (title.mediaType !== 'tv' || !Number.isInteger(season) || season < 0) return void res.status(400).json({ error: 'invalid_season' });
    const at = clock();
    const episodes: EpisodeRow[] = (seasonGroups(title).get(season) ?? [])
      .sort((a, b) => a.number - b.number)
      .map(({ episode, number }) => {
        const airs = episodeEligibleAt(episode.airDate);
        const entry = db.data.queue[entryId(title.key, episode.season, episode.number)];
        const file = episode.fileId ? at.files[episode.fileId] : undefined;
        return {
          season,
          number,
          name: episode.name,
          airDate: episode.airDate,
          runtime: episode.runtime,
          monitored: isMonitored(title, episode),
          override: episode.override,
          aired: airs !== null && airs <= at.now,
          hasFile: Boolean(file && !file.missing),
          queue: entry && entry.attempt > 0 && !entry.clearedAt ? statusOf(entry) : null,
        };
      });
    res.json({ season, episodes });
  };
}
