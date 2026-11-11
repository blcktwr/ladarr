import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Poller } from '../../../../library/downloads/poller.ts';
import type { ImportStatus } from '../../../../library/imports/status.ts';
import { bySeasonNumber, filtersOf, lanePositions, matches, view } from '../../../../helpers/queue.ts';

// The episodes of one season of a series, in the order of the season and the number. Without a season, it shows every
// season of the series.
export function queueGroupGet(poller: Poller, importStatus: ImportStatus | undefined): RequestHandler<{ titleKey: string }> {
  return (req, res) => {
    const f = filtersOf(req.query);
    const lane = lanePositions();
    const season = req.query.season === undefined ? null : Number(req.query.season);
    const entries = Object.values(db.data.queue).filter((entry) => entry.titleKey === req.params.titleKey && entry.season !== null && (season === null || entry.season === season) && matches(entry, f));
    res.json({ cursor: db.data.queueRev, items: entries.sort(bySeasonNumber).map((entry) => view(poller, importStatus, entry, lane)) });
  };
}
