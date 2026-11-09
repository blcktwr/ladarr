import type { RequestHandler } from 'express';
import type { Db } from '../../../../core/db.ts';
import type { Poller } from '../../../../library/downloads/poller.ts';
import type { ImportStatus } from '../../../../library/imports/status.ts';
import { bySeasonNumber, filtersOf, lanePositions, matches, view } from '../../../../helpers/queue.ts';

// The episodes of one series, of every season, in the order of the season and the number.
export function queueGroupGet(db: Db, poller: Poller, importStatus: ImportStatus | undefined): RequestHandler<{ titleKey: string }> {
  return (req, res) => {
    const f = filtersOf(req.query);
    const lane = lanePositions(db);
    const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === req.params.titleKey && entry.season !== null && matches(db, entry, f));
    res.json({ cursor: db.data.queueRev, items: entries.sort(bySeasonNumber).map((entry) => view(db, poller, importStatus, entry, lane)) });
  };
}
