import { reconcile } from '../library/imports/reconcile.ts';
import type { Finder, Handler, Queue } from '../types.ts';

const SWEEP_EVERY_MS = 15 * 60_000;

export function queueSweepHandler(finder: Finder, queue: Queue): Handler {
  return {
    concurrency: 1,
    every: SWEEP_EVERY_MS,
    run: async () => {
      await reconcile(queue);
      finder.sweep();
    },
  };
}
