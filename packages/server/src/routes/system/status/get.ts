import type { ClientState } from '@ladarr/shared/enums';
import type { SystemStatus } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import type { Tmdb } from '../../../metadata/tmdb.ts';
import { collectProblems } from '../../../system/health.ts';

type Deps = { tmdb?: Tmdb; heartbeat?: () => number; backupDir?: string; clientCheck?: () => Promise<ClientState>; ffprobe?: () => Promise<boolean> };

export function systemStatus(db: Db, deps: Deps): RequestHandler {
  return async (_req, res) => {
    res.json({ problems: await collectProblems({ db, ...deps }) } satisfies SystemStatus);
  };
}
