import type { Finder, Handler } from '../types.ts';

const SWEEP_EVERY_MS = 15 * 60_000;

export function queueSweepHandler(finder: Finder): Handler {
  return {
    concurrency: 1,
    every: SWEEP_EVERY_MS,
    run: async () => finder.sweep(),
  };
}
