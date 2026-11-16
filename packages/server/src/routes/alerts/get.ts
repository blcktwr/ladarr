import { db } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { collectAlerts } from '../../system/alerts.ts';
import type { GetDeps } from '../../types.ts';

export function alertsGet(deps: GetDeps): RequestHandler {
  return async (_req, res) => {
    res.json({ alerts: await collectAlerts({ ...deps }) });
  };
}
