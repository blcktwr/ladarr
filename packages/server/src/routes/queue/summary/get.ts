import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Poller } from '../../../library/downloads/poller.ts';
import { describe } from '@ladarr/shared/queue';
import { DAY_MS, itemJobs, jobLabel, queueTabCounts, shown } from '../../../helpers/queue.ts';

export function queueSummaryGet(poller: Poller): RequestHandler {
  return (_req, res) => {
    // The counters count rows, so a badge equals the rows of its tab. A series counts once for each tab that holds one
    // of its targets, as its row appears in each of those tabs.
    const counts = queueTabCounts();
    const working: Record<string, number> = {};
    let stopped = 0;
    let targets = 0;
    let paused = 0;
    for (const entry of Object.values(db.data.queue)) {
      if (!shown(entry) || entry.clearedAt) continue;
      targets++;
      const description = describe(entry.state);
      if (entry.state.kind === 'paused') paused++;
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
