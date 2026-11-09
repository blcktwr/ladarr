import type { RequestHandler } from 'express';
import { listBackups } from '../../system/backup.ts';

export function backupsGet(dir: string): RequestHandler {
  return async (_req, res) => {
    res.json({ backups: await listBackups(dir) });
  };
}
