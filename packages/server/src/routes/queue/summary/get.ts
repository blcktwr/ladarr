import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import type { Poller } from '../../../library/downloads/poller.ts';
import { loadingTitleKeys, queueKey } from '../../../library/downloads/queue.ts';
import { DAY_MS, itemJobs, jobLabel, shown } from '../../../helpers/queue.ts';

export function queueSummaryGet(db: Db, poller: Poller): RequestHandler {
  return (_req, res) => {
    const counts: Record<string, number> = {};
    const working: Record<string, number> = {};
    let stopped = 0;
    let targets = 0;
    for (const entry of Object.values(db.data.queue)) {
      if (!shown(db, entry) || entry.clearedAt) continue;
      targets++;
      const key = queueKey(entry);
      counts[key] = (counts[key] ?? 0) + 1;
      // A target that can still move has no branch and no reason. One with a reason waits for the person.
      if (entry.branch !== null || entry.stage === 'available') continue;
      if (entry.reason) stopped++;
      else working[entry.stage] = (working[entry.stage] ?? 0) + 1;
    }
    // A series that waits for its episodes counts as one target that searches.
    for (const key of loadingTitleKeys(db)) {
      targets++;
      counts.searching = (counts.searching ?? 0) + 1;
      working.searching = (working.searching ?? 0) + 1;
    }
    const transfers = poller.transfers().filter((t) => !t.complete);
    const since = Date.now() - DAY_MS;
    const current = itemJobs(db).find((job) => job.state === 'running');
    res.json({
      cursor: db.data.queueRev,
      counts,
      working,
      stopped,
      paused: db.data.queuePaused,
      targets,
      activeTransfers: transfers.length,
      // Each torrent counts once, also when it covers many targets.
      downloadRate: transfers.reduce((sum, t) => sum + t.downloadRate, 0),
      recentCompletions: Object.values(db.data.queue).filter((entry) => entry.completedAt && entry.completedAt > since).length,
      client: poller.status(),
      hasClient: db.data.downloadClients.some((client) => client.enabled),
      indexers: Object.keys(db.data.indexers).length,
      currentJob: current ? { type: current.type, label: jobLabel(db, current) } : null,
    });
  };
}
