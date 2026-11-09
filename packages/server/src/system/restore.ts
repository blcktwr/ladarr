import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Router, type Request, type RequestHandler, type Response } from 'express';
import { BackupError, createBackup, isBackupName, readBackup } from './backup.ts';
import { withDefaults, type Db } from '../core/db.ts';
import { unfinishedImports } from '../library/importer.ts';
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
// shortcut: the restore runs in the process that serves the requests. A restart in a safe way needs a supervisor, and ladarr has none.
export function createRestorer({ db, dir, worker, drainMs = 10_000 }: { db: Db; dir: string; worker: Worker; drainMs?: number }) {
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
      const safety = await createBackup(db, dir, 'safety');

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
      for (const hash of unfinishedImports(db)) worker.enqueue({ type: 'import.run', payload: { hash }, dedupeKey: `import:${hash}` });
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

// A backup holds one database file, packed. The limit is far above the size of any real backup.
export const MAX_UPLOAD_BYTES = 128 * 1024 ** 2;

// Reads the body of a request into memory, and stops at the limit.
async function readBody(req: Request, maxBytes: number) {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > maxBytes) return undefined;
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The body is the backup file. The user sends a file that is not in the backup folder, for example from another machine.
async function restoreUpload(restorer: Restorer, req: Request, res: Response) {
  if (!req.is(['application/zip', 'application/octet-stream'])) return void res.status(400).json({ error: 'invalid_archive' });
  // A refusal by size does not read the whole body, so the connection closes.
  const tooLarge = () => void res.set('Connection', 'close').status(413).json({ error: 'backup_too_large' });
  if (Number(req.headers['content-length']) > MAX_UPLOAD_BYTES) return tooLarge();
  const body = await readBody(req, MAX_UPLOAD_BYTES).catch(() => null);
  if (body === undefined) return tooLarge();
  // A client that stops the upload leaves no complete file.
  if (!body?.length) return void res.status(400).json({ error: 'invalid_archive' });
  try {
    res.json({ ok: true, ...(await restorer.restore(body, res)) });
  } catch (error) {
    if (error instanceof BackupError) return void res.status(422).json({ error: error.code });
    if (error instanceof RestoreError) return void res.status(409).json({ error: error.code });
    throw error;
  }
}

// The first run has no owner, so the setup screen has no session. A backup carries its own owner, and the restore
// takes the place of the setup. The route closes as soon as an owner exists, which is the same window that the setup
// form already has.
export function setupRestoreRouter({ restorer, db }: { restorer: Restorer; db: Db }) {
  const router = Router();
  router.post('/restore', async (req, res) => {
    if (db.data.owner) return void res.status(409).json({ error: 'setup_closed' });
    await restoreUpload(restorer, req, res);
  });
  return router;
}

export function restoreRouter(restorer: Restorer) {
  const router = Router();
  router.post('/restore', async (req, res) => {
    if (!res.locals.session) return void res.status(403).json({ error: 'session_required' });
    await restoreUpload(restorer, req, res);
  });
  router.post('/:name/restore', async (req, res) => {
    // The API key must not replace the owner login and the API key. Only a session starts a restore.
    if (!res.locals.session) return void res.status(403).json({ error: 'session_required' });
    if (!isBackupName(req.params.name)) return void res.status(404).json({ error: 'not_found' });
    try {
      res.json({ ok: true, ...(await restorer.restore(req.params.name, res)) });
    } catch (error) {
      if (error instanceof BackupError) return void res.status(422).json({ error: error.code });
      if (error instanceof RestoreError) return void res.status(error.code === 'not_found' ? 404 : 409).json({ error: error.code });
      throw error;
    }
  });
  return router;
}
