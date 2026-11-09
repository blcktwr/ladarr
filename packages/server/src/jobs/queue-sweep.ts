import type { Finder } from '../library/grab/finder.ts';
import type { Handler } from '../core/worker.ts';

const SWEEP_EVERY_MS = 15 * 60_000;

export function queueSweepHandler(finder: Finder): Handler {
  return {
    concurrency: 1,
    every: SWEEP_EVERY_MS,
    run: async () => finder.sweep(),
  };
}
