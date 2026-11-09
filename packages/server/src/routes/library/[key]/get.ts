import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { detail } from '../../../helpers/library.ts';

export function libraryTitleGet(db: Db): RequestHandler<{ key: string }> {
  return (_req, res) => {
    res.json({ title: detail(db, res.locals.title) });
  };
}
