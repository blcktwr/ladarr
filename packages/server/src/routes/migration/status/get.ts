import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { progress } from '../../../helpers/migration.ts';

export function migrationStatus(db: Db): RequestHandler {
  return (_req, res) => {
    res.json(progress(db));
  };
}
