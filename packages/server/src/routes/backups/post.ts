import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.ts';
import { createBackup } from '../../system/backup.ts';

export function backupsCreate(db: Db, dir: string): RequestHandler {
  return async (_req, res) => {
    res.status(201).json({ backup: await createBackup(db, dir, 'manual') });
  };
}
