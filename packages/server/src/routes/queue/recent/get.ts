import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import type { Poller } from '../../../library/downloads/poller.ts';
import type { ImportStatus } from '../../../library/imports/status.ts';
import { lanePositions, MAX_PAGE, shown, view } from '../../../helpers/queue.ts';

export function queueRecentGet(db: Db, poller: Poller, importStatus: ImportStatus | undefined): RequestHandler {
  return (req, res) => {
    const limit = Math.min(Math.max(Number(req.query.limit) || 20, 1), MAX_PAGE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const lane = lanePositions(db);
    const done = Object.values(db.data.queue).filter((entry) => entry.stage === 'available' && entry.completedAt && shown(db, entry)).sort((a, b) => b.completedAt! - a.completedAt!);
    res.json({ total: done.length, items: done.slice(offset, offset + limit).map((entry) => view(db, poller, importStatus, entry, lane)) });
  };
}
