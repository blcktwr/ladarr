import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Restorer } from '../../../system/restore.ts';
import { restoreUpload } from '../../../helpers/backups.ts';

// The first run has no owner, so the setup screen has no session. A backup carries its own owner, and the restore
// takes the place of the setup. The route closes as soon as an owner exists, which is the same window that the setup
// form already has.
export function setupRestore(restorer: Restorer): RequestHandler {
  const db = get();
  return async (req, res) => {
    if (db.data.owner) return void res.status(409).json({ error: 'setup_closed' });
    await restoreUpload(restorer, req, res);
  };
}
