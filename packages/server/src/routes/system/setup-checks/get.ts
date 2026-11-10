import { db } from '../../../core/db.ts';
import type { ClientState } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import { setupChecks } from '../../../system/setup-checks.ts';

export function systemSetupChecks(clientCheck?: () => Promise<ClientState>): RequestHandler {
  return async (_req, res) => {
    res.json(await setupChecks(clientCheck));
  };
}
