import { db } from '../../../core/db.ts';
import type { SystemStatus } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { collectProblems } from '../../../system/health.ts';
import type { StatusDeps } from '../../../types.ts';

export function systemStatus(deps: StatusDeps): RequestHandler {
  return async (_req, res) => {
    res.json({ problems: await collectProblems({ ...deps }) } satisfies SystemStatus);
  };
}
