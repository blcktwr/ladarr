import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Poller } from '../../../../library/downloads/poller.ts';
import type { ImportStatus } from '../../../../library/imports/status.ts';
import { lanePositions, shown, view } from '../../../../helpers/queue.ts';

export function queueEntryGet(poller: Poller, importStatus: ImportStatus | undefined): RequestHandler<{ id: string }> {
  return (req, res) => {
    const entry = db.data.queue[req.params.id];
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    res.json({ entry: view(poller, importStatus, entry, lanePositions(), true) });
  };
}
