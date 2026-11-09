import type { RequestHandler } from 'express';
import type { Db } from '../../../../core/db.ts';
import { planFolder } from '../../../../library/imports/manual.ts';
import { fail, input } from '../../../../helpers/import-folder.ts';

// Shows what an import would do. Nothing changes.
export function importFolderPreview(db: Db, { configDir }: { configDir?: string } = {}): RequestHandler {
  return async (req, res) => {
    try {
      const { steps: _steps, real: _real, ...plan } = await planFolder(db, input(req.body, configDir));
      res.json({ plan });
    } catch (error) {
      fail(res, error);
    }
  };
}
