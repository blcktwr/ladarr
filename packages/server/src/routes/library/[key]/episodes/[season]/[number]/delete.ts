import { db } from '../../../../../../core/db.ts';
import { deleteItemLog } from '../../../../../../core/log.ts';
import { entryId, forgetSource, isActive } from '../../../../../../library/downloads/queue.ts';
import { changed, detail } from '../../../../../../helpers/library.ts';
import type { RequestHandler } from 'express';
import type { Events, Queue, QueueEntry, Title } from '../../../../../../types.ts';

// Discards one episode of a series: it stops being monitored, the file association goes, and its target leaves the
// queue. The season can then end without it, because the person decided that the metadata has an episode it lacks.
export function libraryEpisodeDiscard({ events, queue }: { events: Events; queue?: Queue }): RequestHandler<{ key: string; season: string; number: string }> {
  return async (req, res) => {
    const title: Title = res.locals.title;
    const season = Number(req.params.season);
    const number = Number(req.params.number);
    const episode = title.mediaType === 'tv' ? title.episodes.find((item) => item.season === season && item.number === number) : undefined;
    if (!episode) return void res.status(404).json({ error: 'not_found' });
    const id = entryId(title.key, season, number);
    const entry: QueueEntry | undefined = db.data.queue[id];
    if (entry && queue) {
      if (entry.attempt > 0 && isActive(entry)) {
        queue.endAttempt(entry, 'cancelled', 'episode discarded');
        queue.cancel(entry, 'episode discarded');
      }
    }
    if (entry?.release?.uploadPath && entry.source) forgetSource(entry);
    deleteItemLog(id);
    delete db.data.queue[id];
    for (const file of Object.values(db.data.files)) {
      if (file.titleKey !== title.key) continue;
      file.episodes = file.episodes.filter((point) => point.season !== season || point.number !== number);
    }
    episode.fileId = null;
    episode.override = 'unmonitored';
    // A file that another target chose for this episode no longer names it.
    for (const other of Object.values(db.data.queue)) {
      if (other.titleKey !== title.key || !other.manualMatch) continue;
      const covers = other.manualMatch.covers.filter((point) => point.season !== season || point.number !== number);
      if (covers.length === other.manualMatch.covers.length) continue;
      other.manualMatch = covers.length ? { ...other.manualMatch, covers } : null;
      queue?.touch(other);
    }
    await changed(events, title.key);
    queue?.notify();
    res.json({ title: detail(title) });
  };
}
