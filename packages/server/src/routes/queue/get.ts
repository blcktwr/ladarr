import type { RequestHandler } from 'express';
import { filtersOf, MAX_PAGE, queuePage } from '../../helpers/queue.ts';
import type { ImportStatus, Poller } from '../../types.ts';

// One page of rows: one row for each season of a series, and one row for each movie. Rows with the most advanced
// progress come first, and ties keep the order of creation. A row leaves the list when its targets are all available.
export function queueGet(poller: Poller, importStatus: ImportStatus | undefined): RequestHandler {
  return (req, res) => {
    const f = filtersOf(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_PAGE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);

    res.json(queuePage(poller, importStatus, f, limit, offset));
  };
}
