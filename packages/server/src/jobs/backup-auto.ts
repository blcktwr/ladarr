import { type Db, db } from '../core/db.ts';
import { log } from '../core/log.ts';
import type { Handler } from '../core/worker.ts';
import { createBackup, listBackups, pruneBackups } from '../system/backup.ts';

const AUTO_EVERY_MS = 24 * 60 * 60_000;

export function backupAutoHandler(dir: string): Handler {
  return {
    // Checks every hour. A backup starts only when the last automatic one is a day old.
    every: 60 * 60_000,
    maxAttempts: 3,
    run: async () => {
      const last = (await listBackups(dir)).find((backup) => backup.kind === 'auto');
      if (last && Date.now() - last.createdAt < AUTO_EVERY_MS) return;
      const made = await createBackup(dir, 'auto');
      await pruneBackups(dir);
      log.info('backup made', { name: made.name, bytes: made.bytes });
    },
  };
}
