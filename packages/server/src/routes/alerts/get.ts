import type { ClientState } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.ts';
import type { Tmdb } from '../../metadata/tmdb.ts';
import { collectAlerts } from '../../system/alerts.ts';

type Deps = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };

export function alertsGet(db: Db, deps: Deps): RequestHandler {
  return async (_req, res) => {
    res.json({ alerts: await collectAlerts({ db, ...deps }) });
  };
}
