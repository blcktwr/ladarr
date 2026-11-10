import { get } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { planFolder } from '../../../../library/imports/manual.ts';
import { fail, input } from '../../../../helpers/import-folder.ts';

// Shows what an import would do. Nothing changes.
export function importFolderPreview({ configDir }: { configDir?: string } = {}): RequestHandler {
  const db = get();
  return async (req, res) => {
    try {
      const { steps: _steps, real: _real, ...plan } = await planFolder(db, input(req.body, configDir));
      res.json({ plan });
    } catch (error) {
      fail(res, error);
    }
  };
}
