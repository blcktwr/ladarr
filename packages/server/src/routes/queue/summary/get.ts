import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { DAY_MS, itemJobs, jobLabel, queueDescriptions, queueTabCounts } from '../../../helpers/queue.ts';
import type { Poller } from '../../../types.ts';

export function queueSummaryGet(poller: Poller): RequestHandler {
  return (_req, res) => {
    const counts = queueTabCounts();
    const working: Record<string, number> = {};
    let stopped = 0;
    let paused = 0;
    const { descriptions, targets } = queueDescriptions();
    for (const description of descriptions) {
      if (description.status === 'paused') paused++;
      // A target that cannot move without the user waits: it is blocked, paused, or waits for its next search.
      if (description.working) working[description.phase] = (working[description.phase] ?? 0) + 1;
      else if (description.status === 'stuck') stopped++;
    }
    // The line of the app asks whether any target is paused in its own word, not in a tab.
    if (paused) counts.paused = paused;
    const transfers = poller.transfers().filter((t) => !t.complete);
    const since = Date.now() - DAY_MS;
    const current = itemJobs().find((job) => job.state === 'running');
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
      currentJob: current ? { type: current.type, label: jobLabel(current) } : null,
    });
  };
}
