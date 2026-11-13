import { db } from '../../core/db.ts';
import type { QueuePage, QueueRow } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Poller } from '../../library/downloads/poller.ts';
import { isActive, loadingTitleKeys, queueKey, type QueueEntry } from '../../library/downloads/queue.ts';
import type { ImportStatus } from '../../library/imports/status.ts';
import { filtersOf, isUpcoming, lanePositions, matches, MAX_PAGE, progressOf, reachedOf, shown, STAGE_RANK, titleOf, view } from '../../helpers/queue.ts';

// One page of rows: one row for each season of a series, and one row for each movie. Rows with the most advanced
// progress come first, and ties keep the order of creation. A row leaves the list when its targets are all available.
export function queueGet(poller: Poller, importStatus: ImportStatus | undefined): RequestHandler {
  return (req, res) => {
    const f = filtersOf(req.query);
    const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), MAX_PAGE);
    const offset = Math.max(Number(req.query.offset) || 0, 0);
    const lane = lanePositions();
    const all = Object.values(db.data.queue);
    const cursor = db.data.queueRev;

    if (f.priority) {
      const rows = all.filter((entry) => matches(entry, f)).sort((a, b) => a.priority! - b.priority!);
      return void res.json({ cursor, total: rows.length, items: rows.slice(offset, offset + limit).map((entry) => ({ kind: 'entry', ...view(poller, importStatus, entry, lane) })) });
    }

    // Counts of a group cover all its entries in the view. A filter picks the groups that have a matching entry.
    // The progress of a group is that of its least advanced target, so the number of episodes does not matter. Two
    // rows at the same place order by the part that their least advanced downloading target has of its file.
    const groups = new Map<string, { entries: QueueEntry[]; matching: number; first: number; progress: number; part: number; download: number; ready: boolean; searching: boolean; upcoming: boolean; notFound: boolean }>();
    for (const entry of all) {
      if (!shown(entry) || (!f.cleared && entry.clearedAt)) continue;
      const key = entry.season === null ? entry.id : `${entry.titleKey}:${entry.season}`;
      const group = groups.get(key) ?? { entries: [], matching: 0, first: entry.createdAt, progress: Number.POSITIVE_INFINITY, part: -1, download: -1, ready: false, searching: false, upcoming: isUpcoming(titleOf(entry)!), notFound: false };
      group.entries.push(entry);
      // A target that found no release waits for a new release, so its row goes after the rows that still have work.
      if (queueKey(entry) === 'not_found') group.notFound = true;
      if (matches(entry, f)) group.matching++;
      group.first = Math.min(group.first, entry.createdAt);
      // An available target is finished. It does not hold the group back.
      if (entry.stage !== 'available') group.progress = Math.min(group.progress, progressOf(entry));
      // A download that works: it has no branch, no reason, and a part of its file from the client.
      if (entry.stage === 'downloading' && entry.branch === null && entry.reason === null) {
        const transfer = entry.transferHash ? poller.transfer(entry.transferHash) : undefined;
        // The part of the least advanced file, for the order of the rows. A pack downloads its files one by one.
        const part = transfer ? (transfer.entryProgress?.[entry.id] ?? transfer.progress) : null;
        if (part !== null) group.part = group.part < 0 ? part : Math.min(group.part, part);
        // The bar of the group shows the part of the torrent that the client reports, as the client shows it.
        if (transfer) group.download = group.download < 0 ? transfer.progress : Math.min(group.download, transfer.progress);
      }
      // A target that has its release waits for a free slot of its client. Its row goes above the rows that only
      // search, because it is the target that takes the next slot.
      if (entry.stage === 'fetching' && entry.branch === null && entry.reason === null) group.ready = true;
      // The search of a title runs now, so its row stays above the rows that wait for their next search.
      if (entry.stage === 'searching' && entry.branch === null) group.searching = true;
      groups.set(key, group);
    }
    // A series that waits for its episodes has no target yet. The page shows the series itself as searching, so
    // the row is in the queue from the moment of the add.
    for (const key of loadingTitleKeys()) {
      const title = db.data.titles[key];
      if (!title) continue;
      const matchesLoading = !f.cleared && !f.priority && (!f.key || f.key === 'searching') && (!f.type || f.type === 'tv') && (!f.q || title.meta.title.toLowerCase().includes(f.q));
      if (!matchesLoading) continue;
      groups.set(key, { entries: [], matching: 1, first: title.addedAt, progress: STAGE_RANK.get('searching')!, part: -1, download: -1, ready: false, searching: true, upcoming: isUpcoming(title), notFound: false });
    }
    // A title that waits for its release has no work in the queue yet, so its rows go after the rest. A group with a
    // target that found no release goes after every other row, because a new release is its only next step.
    const rows = [...groups.entries()].filter(([, g]) => g.matching > 0 && Number.isFinite(g.progress)).sort((a, b) => Number(a[1].notFound) - Number(b[1].notFound) || Number(a[1].upcoming) - Number(b[1].upcoming) || b[1].progress - a[1].progress || b[1].part - a[1].part || Number(b[1].ready) - Number(a[1].ready) || Number(b[1].searching) - Number(a[1].searching) || a[1].first - b[1].first || a[0].localeCompare(b[0]));
    const items: QueueRow[] = rows.slice(offset, offset + limit).map(([key, group]) => {
      const first = group.entries[0];
      if (!first) {
        const title = db.data.titles[key]!;
        return {
          kind: 'group',
          key,
          titleKey: key,
          title: title.meta.title,
          year: title.meta.year,
          posterPath: title.meta.posterPath,
          season: null,
          total: 0,
          reached: { found: 0, completed: 0, validated: 0, imported: 0 },
          download: null,
          matching: group.matching,
          counts: { searching: 1 },
          priority: false,
          pending: true,
        };
      }
      if (first.season === null) return { kind: 'entry', ...view(poller, importStatus, first, lane) };
      const title = titleOf(first)!;
      const counts: Record<string, number> = {};
      for (const entry of group.entries) counts[queueKey(entry)] = (counts[queueKey(entry)] ?? 0) + 1;
      return {
        kind: 'group',
        key,
        titleKey: first.titleKey,
        title: title.meta.title,
        year: title.meta.year,
        posterPath: title.meta.posterPath,
        season: first.season,
        total: group.entries.length,
        reached: reachedOf(group.entries),
        download: group.download < 0 ? null : group.download,
        matching: group.matching,
        counts,
        priority: group.entries.some((entry) => entry.priority !== null && isActive(entry)),
      };
    });
    res.json({ cursor, total: rows.length, items } satisfies QueuePage);
  };
}
