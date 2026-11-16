import { db } from '../../../../core/db.ts';
import type { QueueGroupPage } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Poller } from '../../../../library/downloads/poller.ts';
import type { ImportStatus } from '../../../../library/imports/status.ts';
import { bySeasonNumber, filtersOf, groupAggregate, lanePositions, reachedOf, shown, view } from '../../../../helpers/queue.ts';

// The episodes of one season of a series, in the order of the season and the number. Without a season, it shows every
// season of the series. `group` covers every member of the season before the tab filter, so the inspector header and
// the row show the same aggregate. `items` holds every episode of the season: the tab of the page filters the rows,
// not the children.
export function queueGroupGet(poller: Poller, importStatus: ImportStatus | undefined): RequestHandler<{ titleKey: string }> {
  return (req, res) => {
    const f = filtersOf(req.query);
    const lane = lanePositions();
    const season = req.query.season === undefined ? null : Number(req.query.season);
    const all = Object.values(db.data.queue).filter(
      (entry) => entry.titleKey === req.params.titleKey && entry.season !== null && (season === null || entry.season === season) && shown(entry) && (f.cleared || !entry.clearedAt),
    );
    const items = [...all].sort(bySeasonNumber);
    // The download of the group is the part of the least advanced torrent that the client reports.
    let download: number | null = null;
    for (const entry of all) {
      if (entry.state.kind !== 'downloading' || !entry.transferHash) continue;
      const transfer = poller.transfer(entry.transferHash);
      if (!transfer) continue;
      download = download === null ? transfer.progress : Math.min(download, transfer.progress);
    }
    const summary = groupAggregate(all);
    res.json({
      cursor: db.data.queueRev,
      group: {
        status: summary.status,
        counts: summary.counts,
        tabs: summary.tabs,
        total: all.length,
        reached: reachedOf(all),
        download,
        problem: summary.problem,
        otherSeasons: summary.otherSeasons,
      },
      items: items.map((entry) => view(poller, importStatus, entry, lane)),
    } satisfies QueueGroupPage);
  };
}
