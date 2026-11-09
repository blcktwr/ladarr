import type { Db } from './db.ts';

type Waiter = { urgent: boolean; resolve: () => void };

// One limiter for all requests to an indexer: searches, RSS, .torrent downloads, and retries.
// A request starts only after `delaySeconds` since the start of the request before it.
// The limiter delays a request. It never drops one.
export function createLimiter(db: Db, onChange: () => void = () => {}) {
  const queues = new Map<number, Waiter[]>();
  const timers = new Map<number, NodeJS.Timeout>();

  function pump(id: number) {
    clearTimeout(timers.get(id));
    timers.delete(id);
    const queue = queues.get(id);
    if (!queue?.length) return;
    const indexer = db.data.indexers[id];
    if (!indexer) {
      // The indexer is gone. The waiting request must not wait for a time that never comes.
      queues.delete(id);
      for (const waiter of queue) waiter.resolve();
      return;
    }
    const now = Date.now();
    // A clock that moved back must not hold the queue for longer than one delay.
    const wait = Math.min(indexer.nextRequestAt - now, indexer.delaySeconds * 1000);
    if (wait > 0) {
      timers.set(id, setTimeout(() => pump(id), wait));
      return;
    }
    // A download goes before a search, so a chosen release does not wait behind a long list of searches.
    const next = queue.findIndex((waiter) => waiter.urgent);
    const [waiter] = queue.splice(next >= 0 ? next : 0, 1);
    indexer.nextRequestAt = now + indexer.delaySeconds * 1000;
    onChange();
    waiter!.resolve();
    pump(id);
  }

  return {
    // Resolves when the request can start. An aborted wait leaves the queue and does not use a slot.
    acquire(id: number, { urgent = false, signal }: { urgent?: boolean; signal?: AbortSignal } = {}) {
      return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) return reject(signal.reason);
        const waiter: Waiter = {
          urgent,
          resolve: () => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
          },
        };
        const onAbort = () => {
          const queue = queues.get(id) ?? [];
          const at = queue.indexOf(waiter);
          if (at >= 0) queue.splice(at, 1);
          reject(signal!.reason);
        };
        signal?.addEventListener('abort', onAbort, { once: true });
        queues.set(id, [...(queues.get(id) ?? []), waiter]);
        pump(id);
      });
    },
    waiting: (id: number) => queues.get(id)?.length ?? 0,
    stop() {
      for (const timer of timers.values()) clearTimeout(timer);
      timers.clear();
    },
  };
}

export type Limiter = ReturnType<typeof createLimiter>;
