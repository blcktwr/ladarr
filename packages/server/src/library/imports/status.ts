import type { RunStatus } from '@ladarr/shared/types';
import { stat } from 'node:fs/promises';
import type { Events } from '../../core/events.ts';

// What the importer is doing now, in memory. The journal and the library hold the facts. This holds the numbers
// that the client reads again after a restart: the bytes of a running copy, and the result of a manual import or a rename.

export type CopyProgress = { journalId: string; dest: string; entryIds: string[]; copiedBytes: number; totalBytes: number; observedAt: number };

const MAX_RUNS = 50;
const PUBLISH_MS = 1_000;

export function createImportStatus(events: Events, { pollMs = 500, now = Date.now }: { pollMs?: number; now?: () => number } = {}) {
  const copies = new Map<string, CopyProgress>();
  const runs = new Map<string, RunStatus>();
  let lastPublish = 0;

  function publish(force: boolean) {
    const at = now();
    if (!force && at - lastPublish < PUBLISH_MS) return;
    lastPublish = at;
    events.publish('import.copy', { at, copies: [...copies.values()] });
  }

  return {
    // Reads the size of the staged file while the copy runs. The size on the disk is the measured progress.
    // Call the returned function when the copy ends, whatever the result.
    watchCopy(journalId: string, dest: string, entryIds: string[], stagePath: string, totalBytes: number) {
      const key = `${journalId}:${dest}`;
      const read = async () => {
        const info = await stat(stagePath).catch(() => undefined);
        if (!info || !copies.has(key)) return;
        copies.set(key, { journalId, dest, entryIds, copiedBytes: Math.min(info.size, totalBytes), totalBytes, observedAt: now() });
        publish(false);
      };
      copies.set(key, { journalId, dest, entryIds, copiedBytes: 0, totalBytes, observedAt: now() });
      publish(true);
      const timer = setInterval(() => void read(), pollMs);
      return () => {
        clearInterval(timer);
        copies.delete(key);
        publish(true);
      };
    },

    copyOf: (entryId: string) => [...copies.values()].find((copy) => copy.entryIds.includes(entryId)),
    copyOfStep: (journalId: string, dest: string) => copies.get(`${journalId}:${dest}`),

    begin(id: string, kind: RunStatus['kind'], titleKey: string, total: number) {
      runs.set(id, { id, kind, titleKey, total, done: 0, problems: [], finished: false, startedAt: now() });
      // The oldest runs go first. A map keeps the order of insertion.
      for (const old of [...runs.keys()].slice(0, Math.max(0, runs.size - MAX_RUNS))) runs.delete(old);
    },
    stepDone(id: string) {
      const run = runs.get(id);
      if (run) run.done++;
    },
    problem(id: string, file: string, code: string, detail?: string) {
      runs.get(id)?.problems.push({ file, code, ...(detail ? { detail } : {}) });
    },
    finish(id: string) {
      const run = runs.get(id);
      if (run) run.finished = true;
    },
    run: (id: string) => runs.get(id),
  };
}

export type ImportStatus = ReturnType<typeof createImportStatus>;
