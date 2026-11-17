import { db } from '../core/db.ts';
import { JobError } from '../core/jobs.ts';
import { ClientError } from '../library/downloads/qbittorrent.ts';
import { isActive, phaseOfEntry } from '../library/downloads/queue.ts';
import { createImporter } from '../library/imports/importer.ts';
import { MAX_IMPORT_ATTEMPTS } from '../library/imports/limits.ts';
import type { Handler, ImportDeps, QueueEntry } from '../types.ts';

const MAX_ATTEMPTS = 5;

// The targets of one download that the import checks.
const targetsOf = (hash: string) => Object.values(db.data.queue).filter((entry) => entry.transferHash === hash && isActive(entry) && phaseOfEntry(entry) === 'importing');

// A failed step blocks its target at the import. The attempt that failed counts, and the target stops after the third.
function countAttempt(entries: QueueEntry[]) {
  for (const entry of entries) {
    if (entry.state.kind !== 'blocked' || entry.state.at !== 'importing') continue;
    entry.importTries = Math.min((entry.importTries ?? 0) + 1, MAX_IMPORT_ATTEMPTS);
  }
}

export function importRunHandler(deps: ImportDeps): Handler {
  const { run } = createImporter(deps);
  return {
    concurrency: 1,
    maxAttempts: MAX_ATTEMPTS,
    run: async (job) => {
      const { hash, manual } = job.payload as { hash: string; manual?: boolean };
      const targets = targetsOf(hash);
      // A journal that an earlier run left open has work of its own, such as a rename or a staged file.
      const journal = Object.values(db.data.imports).some((item) => item.hash === hash);
      // The targets used their automatic attempts. They stay stuck until the user retries one of them.
      if (!manual && !journal && targets.length && targets.every((entry) => (entry.importTries ?? 0) >= MAX_IMPORT_ATTEMPTS)) return;
      const ready = targets.filter((entry) => entry.state.kind === 'importing');
      if (!ready.length && !journal) return;
      const ids = ready.map((entry) => entry.id);
      const revisions = new Map(ready.map((entry) => [entry.id, entry.revision]));
      try {
        await run(hash);
      } catch (error) {
        if (error instanceof ClientError) {
          if (job.attempts >= MAX_ATTEMPTS) {
            const problem = { code: error.code === 'rejected' ? 'client_rejected' : 'client_unreachable' };
            for (const entry of ready) {
              if (db.data.queue[entry.id] !== entry || entry.state.kind !== 'importing' || entry.revision !== revisions.get(entry.id)) continue;
              deps.queue.endAttempt(entry, 'failed', problem.code);
              deps.queue.block(entry, problem, 'import client attempts used');
            }
          }
          throw new JobError('outage', error.message);
        }
        throw error;
      }
      if (!manual) countAttempt(ids.map((id) => db.data.queue[id]).filter((entry): entry is QueueEntry => Boolean(entry)));
    },
  };
}
