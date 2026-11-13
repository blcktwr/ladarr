import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { RequestHandler, Response } from 'express';
import { BackupError, createBackup, readBackup } from './backup.ts';
import { db, withDefaults } from '../core/db.ts';
import { unfinishedImports } from '../library/imports/importer.ts';
import type { EnqueueInput } from '../core/jobs.ts';
import { log } from '../core/log.ts';
import { scanJob } from '../library/scan.ts';

export class RestoreError extends Error {
  code: 'restore_in_progress' | 'worker_busy' | 'requests_busy' | 'not_found';
  constructor(code: RestoreError['code']) {
    super(code);
    this.code = code;
  }
}

type Worker = { pause: () => Promise<boolean>; resume: () => void; enqueue: (input: EnqueueInput) => unknown };

// Replaces the data of the running server with the data of a backup, without a restart.
// shortcut: the restore runs in the process that serves the requests. A restart in a safe way needs the supervisor to start the process again.
export function createRestorer({ dir, worker, drainMs = 10_000 }: { dir: string; worker: Worker; drainMs?: number }) {
  let restoring = false;
  // The requests that change data and have no answer yet. One of them can wait for TMDB and write after the swap.
  const active = new Set<Response>();

  async function drain(self?: Response) {
    const end = Date.now() + drainMs;
    while ([...active].some((res) => res !== self)) {
      if (Date.now() > end) throw new RestoreError('requests_busy');
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
  }

  // `source` is the name of a backup in the backup folder, or the bytes of a backup file that the user sent.
  // `self` is the response of the request that asks for the restore. It does not wait for itself.
  async function restore(source: string | Uint8Array, self?: Response): Promise<{ safetyBackup: string }> {
    if (restoring) throw new RestoreError('restore_in_progress');
    // The flag is set before the first await, so a second restore can not start. Requests that change data wait.
    restoring = true;
    let paused = false;
    try {
      const file = typeof source === 'string' ? await readFile(join(dir, source)).catch(() => undefined) : source;
      if (!file) throw new RestoreError('not_found');
      // Nothing is written before this line. A bad backup leaves the installation as it is.
      const { data } = await readBackup(file);
      // A backup holds no sessions, so after the restore everyone signs in again.
      const next = withDefaults(data);

      await drain(self);
      paused = true;
      if (!(await worker.pause())) throw new RestoreError('worker_busy');
      // The jobs are stopped, so this copy holds every change that was made.
      const safety = await createBackup(dir, 'safety');

      const previous = db.data;
      db.data = next;
      try {
        // One write that replaces the file by a rename. The file is the old data or the new data, never a mix.
        await db.write();
      } catch (error) {
        db.data = previous;
        throw error;
      }

      // Downloads that ended and files that moved after the backup are not in the data. These jobs read the disk and the client.
      for (const hash of unfinishedImports()) worker.enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
      // A scan that runs while the importer moves a file can mark the new file as missing. A title with an unfinished import is not scanned.
      const importing = new Set(Object.values(db.data.imports).map((journal) => journal.titleKey));
      for (const title of Object.values(db.data.titles)) if (title.folder && !importing.has(title.key)) worker.enqueue(scanJob(title.key));
      log.info('backup restored', { name: typeof source === 'string' ? source : 'uploaded file', safetyBackup: safety.name });
      return { safetyBackup: safety.name };
    } finally {
      if (paused) worker.resume();
      restoring = false;
    }
  }

  return {
    restore,
    busy: () => restoring,
    track(res: Response) {
      active.add(res);
      res.on('close', () => active.delete(res));
    },
  };
}

export type Restorer = ReturnType<typeof createRestorer>;

// Requests that change data get an error while a restore runs. A read goes through.
// A request that starts before the restore is tracked, and the restore waits for it.
export const restoreGate =
  (restorer: Restorer): RequestHandler =>
  (req, res, next) => {
    if (['GET', 'HEAD', 'OPTIONS'].includes(req.method)) return next();
    if (restorer.busy()) return void res.status(503).json({ error: 'restore_in_progress' });
    restorer.track(res);
    next();
  };

export const MAX_UPLOAD_BYTES = 128 * 1024 ** 2;
