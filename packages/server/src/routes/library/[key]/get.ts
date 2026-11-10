import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { detail } from '../../../helpers/library.ts';

export function libraryTitleGet(): RequestHandler<{ key: string }> {
  return (_req, res) => {
    res.json({ title: detail(res.locals.title) });
  };
}
