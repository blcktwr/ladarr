import type { TitleSummary } from '@ladarr/shared/types';
import { type Db, db } from '../../core/db.ts';
import { availability, movieEligibleAt, seriesCounts, type Title } from '../library.ts';

export const clock = () => ({ now: Date.now(), files: db.data.files });

export function summarize(title: Title): TitleSummary {
  const at = clock();
  const series = title.mediaType === 'tv';
  return {
    key: title.key,
    mediaType: title.mediaType,
    tmdbId: title.tmdbId,
    title: title.meta.title,
    year: title.meta.year,
    posterPath: title.meta.posterPath,
    providerStatus: title.meta.status,
    paused: title.paused,
    seriesType: series ? title.seriesType : null,
    availability: availability(title, at),
    counts: series ? seriesCounts(title, at) : null,
    eligibleAt: series ? null : movieEligibleAt(title),
  };
}
