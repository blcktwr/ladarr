import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Poller } from '../../../library/downloads/poller.ts';
import { loadingTitleKeys, queueKey } from '../../../library/downloads/queue.ts';
import { DAY_MS, itemJobs, jobLabel, shown } from '../../../helpers/queue.ts';

export function queueSummaryGet(poller: Poller): RequestHandler {
  const db = get();
  return (_req, res) => {
    // The titles of each stage. A series counts once for each stage that its episodes show, so its number of episodes
    // does not change the count of the menu.
    const titles = new Map<string, Set<string>>();
    const working: Record<string, number> = {};
    let stopped = 0;
    let targets = 0;
    const add = (key: string, titleKey: string) => {
      const found = titles.get(key) ?? new Set<string>();
      found.add(titleKey);
      titles.set(key, found);
    };
    for (const entry of Object.values(db.data.queue)) {
      if (!shown(db, entry) || entry.clearedAt) continue;
      targets++;
      add(queueKey(entry), entry.titleKey);
      // A target that can still move has no branch and no reason. One with a reason waits for the person.
      if (entry.branch !== null || entry.stage === 'available') continue;
      if (entry.reason) stopped++;
      else working[entry.stage] = (working[entry.stage] ?? 0) + 1;
    }
    // A series that waits for its episodes counts as one target that searches.
    for (const key of loadingTitleKeys(db)) {
      targets++;
      add('searching', key);
      working.searching = (working.searching ?? 0) + 1;
    }
    const counts: Record<string, number> = {};
    for (const [key, found] of titles) counts[key] = found.size;
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
