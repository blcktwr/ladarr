import type { RequestHandler } from 'express';
import { BackupError } from '../../../../system/backup.ts';
import { RestoreError, type Restorer } from '../../../../system/restore.ts';

export function backupRestoreSaved(restorer: Restorer): RequestHandler<{ name: string }> {
  return async (req, res) => {
    try {
      res.json({ ok: true, ...(await restorer.restore(req.params.name, res)) });
    } catch (error) {
      if (error instanceof BackupError) return void res.status(422).json({ error: error.code });
      if (error instanceof RestoreError) return void res.status(error.code === 'not_found' ? 404 : 409).json({ error: error.code });
      throw error;
    }
  };
}
