import { get } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { createBackup } from '../../system/backup.ts';

export function backupsCreate(dir: string): RequestHandler {
  const db = get();
  return async (_req, res) => {
    res.status(201).json({ backup: await createBackup(db, dir, 'manual') });
  };
}
