import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { planRename } from '../../../library/rename.ts';
import { fail, isObject, templatesOf } from '../../../helpers/rename.ts';

export function renamePreview(db: Db): RequestHandler {
  return async (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const naming = templatesOf(db, body);
    if ('invalid' in naming) return void res.status(400).json({ error: 'invalid_template', field: naming.invalid });
    try {
      const { rows } = await planRename(db, String(body.titleKey ?? ''), naming);
      res.json({ rows, counts: { rename: rows.filter((row) => row.status === 'rename').length, blocked: rows.filter((row) => row.status === 'blocked').length } });
    } catch (error) {
      fail(res, error);
    }
  };
}
