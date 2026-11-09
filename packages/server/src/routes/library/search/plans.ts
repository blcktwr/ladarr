import type { Finder } from '../../../library/grab/finder.ts';
import type { Db } from '../../../core/db.ts';
import { isActive } from '../../../library/downloads/queue.ts';
import type { Title } from '../../../library/library.ts';

export const MAX_KEYS = 5_000;
export const MAX_PLANS = 20;
export const SAMPLE = 10;

// A plan of the kind `upgrades` comes from the Upgrade button of a title page. It searches the files below a resolution
// for a release of exactly that resolution. Other plans look for the missing files.
export type Kind = 'search' | 'upgrades';

export type Plan = { keys: string[]; targets: number; kind: Kind; resolution: number; jobId: string | null };

// shortcut: plans stay in memory, so a restart drops them. The user starts the preview again.
export const plans = new Map<string, Plan>();

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The targets that a search would start now: wanted, and not in the journey already.
// A target that waits for a release starts again, like in the finder.
export function startable(db: Db, finder: Finder, title: Title) {
  const free = (id: string) => {
    const entry = db.data.queue[id];
    return !entry || entry.attempt === 0 || !isActive(entry) || entry.branch === 'waiting';
  };
  if (title.mediaType === 'movie') return finder.wantedMovie(title) && free(title.key) ? 1 : 0;
  return title.episodes.filter((episode) => finder.wantedEpisode(title, episode) && free(`${title.key}:${episode.season}x${episode.number}`)).length;
}
