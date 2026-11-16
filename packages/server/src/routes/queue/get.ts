import { db } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { filtersOf, lanePositions, matches, MAX_PAGE, queuePage, view } from '../../helpers/queue.ts';
import type { ImportStatus, Poller } from '../../types.ts';

// One page of rows: one row for each season of a series, and one row for each movie. Rows with the most advanced
// progress come first, and ties keep the order of creation. A row leaves the list when its targets are all available.
export function queueGet(poller: Poller, importStatus: ImportStatus | undefined): RequestHandler {
  return (req, res) => {
    const f = filtersOf(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_PAGE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    // The priority lane shows one row for each target, in the order of the lane.
    if (f.priority) {
      const lane = lanePositions();
      const rows = Object.values(db.data.queue)
        .filter((entry) => matches(entry, f))
        .sort((a, b) => a.priority! - b.priority!);
      return void res.json({ cursor: db.data.queueRev, total: rows.length, items: rows.slice(offset, offset + limit).map((entry) => ({ kind: 'entry', ...view(poller, importStatus, entry, lane) })) });
    }

    res.json(queuePage(poller, importStatus, f, limit, offset));
  };
}
