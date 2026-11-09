import type { ClientState } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { setupChecks } from '../../../system/setup-checks.ts';

export function systemSetupChecks(db: Db, clientCheck?: () => Promise<ClientState>): RequestHandler {
  return async (_req, res) => {
    res.json(await setupChecks(db, clientCheck));
  };
}
