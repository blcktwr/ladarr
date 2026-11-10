import { db } from '../../core/db.ts';
import type { ClientState } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../metadata/tmdb.ts';
import { collectAlerts } from '../../system/alerts.ts';

type Deps = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };

export function alertsGet(deps: Deps): RequestHandler {
  return async (_req, res) => {
    res.json({ alerts: await collectAlerts({ ...deps }) });
  };
}
