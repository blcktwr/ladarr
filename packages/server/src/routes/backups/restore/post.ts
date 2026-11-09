import type { RequestHandler } from 'express';
import { restoreUpload } from '../../../helpers/backups.ts';
import type { Restorer } from '../../../system/restore.ts';

export function backupRestore(restorer: Restorer): RequestHandler {
  return async (req, res) => {
    await restoreUpload(restorer, req, res);
  };
}
