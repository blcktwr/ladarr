import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { progress } from '../../../helpers/migration.ts';

export function migrationStatus(): RequestHandler {
  return (_req, res) => {
    res.json(progress());
  };
}
