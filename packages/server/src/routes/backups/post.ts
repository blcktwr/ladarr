import { db } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { createBackup } from '../../system/backup.ts';

export function backupsCreate(dir: string): RequestHandler {
  return async (_req, res) => {
    res.status(201).json({ backup: await createBackup(dir, 'manual') });
  };
}
