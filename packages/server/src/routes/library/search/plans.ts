import { db } from '../../../core/db.ts';
import { isActive } from '../../../library/downloads/queue.ts';
import type { Finder, SearchPlan, Title } from '../../../types.ts';

export const MAX_KEYS = 5_000;
export const MAX_PLANS = 20;
export const SAMPLE = 10;

// shortcut: plans stay in memory, so a restart drops them. The user starts the preview again.
export const plans = new Map<string, SearchPlan>();

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The targets that a search would start now: wanted, and not in the journey already.
// A target that waits for a release starts again, like in the finder.
export function startable(finder: Finder, title: Title) {
  const free = (id: string) => {
    const entry = db.data.queue[id];
    return !entry || entry.attempt === 0 || !isActive(entry) || entry.state.kind === 'waiting';
  };
  if (title.mediaType === 'movie') return finder.wantedMovie(title) && free(title.key) ? 1 : 0;
  return title.episodes.filter((episode) => finder.wantedEpisode(title, episode) && free(`${title.key}:${episode.season}x${episode.number}`)).length;
}
