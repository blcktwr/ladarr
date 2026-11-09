import type { Finder } from '../acquisition/finder.ts';
import type { Handler } from '../core/worker.ts';

const RSS_EVERY_MS = 15 * 60_000;

export function queueRssHandler(finder: Finder): Handler {
  return {
    concurrency: 1,
    every: RSS_EVERY_MS,
    run: (_job, { signal }) => finder.rss(signal),
  };
}
