import { db } from '../../../../../core/db.ts';
import type { QueueMatchPreview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Finder } from '../../../../../library/grab/finder.ts';
import type { EnqueueInput, Job } from '../../../../../core/jobs.ts';
import type { Clients } from '../../../../../library/downloads/client-api.ts';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { isActive, type Covered, type Queue, type QueueEntry } from '../../../../../library/downloads/queue.ts';
import { createRetry, sharingOf } from '../../../../../library/downloads/queue-api.ts';
import { listDownloadFiles } from '../../../../../library/imports/importer.ts';
import { label, shown } from '../../../../../helpers/queue.ts';

// Matches a file of the download to the target, or to several episodes. The match stays through every retry.
export function queueEntryMatchPost(queue: Queue, finder: Finder, clients: Clients, enqueue: (input: EnqueueInput) => Job): RequestHandler<{ id: string }> {
  const { retry } = createRetry({ queue, finder, enqueue });
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handle = clients.get(entry?.clientId);
    const { file, covers, preview } = (req.body ?? {}) as { file?: unknown; covers?: unknown; preview?: boolean };
    if (!entry?.transferHash || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
    if (typeof file !== 'string') return void res.status(400).json({ error: 'invalid_request' });
    const files = await listDownloadFiles(handle, entry.transferHash).catch(() => undefined);
    // The file must be one that the download has. The path comes from the user, so it is never used as it is.
    if (!files?.some((item) => item.rel === file)) return void res.status(400).json({ error: 'file_not_in_download' });

    const group = sharingOf(entry);
    let covered: QueueEntry[] = [entry];
    if (covers !== undefined) {
      const list = covers as Covered[];
      if (!Array.isArray(list) || list.length > 50 || !list.every((c) => Number.isInteger(c?.season) && Number.isInteger(c?.number))) return void res.status(400).json({ error: 'invalid_request' });
      covered = group.filter((other) => other.titleKey === entry.titleKey && list.some((c) => c.season === other.season && c.number === other.number));
      // A cover that the download does not hold for this title is an error. It is not dropped without a word.
      if (list.some((c) => !covered.some((other) => other.season === c.season && other.number === c.number) && !(entry.season === c.season && entry.number === c.number))) return void res.status(400).json({ error: 'cover_not_in_download' });
      if (!covered.includes(entry)) covered.push(entry);
    }
    // The targets that lose the file because another target takes it.
    const taken = Object.values(db.data.queue).filter((other) => other.transferHash === entry.transferHash && isActive(other) && other.manualMatch?.file === file && !covered.includes(other));
    const preview_: QueueMatchPreview = {
      file,
      // The file that each target has now, so the preview shows every association that changes.
      affected: covered.map((other) => ({ id: other.id, label: label(other), current: other.manualMatch?.file ?? null })),
      replaces: taken.map((other) => ({ id: other.id, label: label(other) })),
      // A target that waits for a repair starts its import again.
      retries: covered.filter((other) => other.reason !== null && (other.stage === 'validating' || other.stage === 'importing')).map((other) => ({ id: other.id, label: label(other) })),
    };
    if (preview) return void res.json(preview_);

    for (const other of taken) other.manualMatch = null;
    const matchCovers = covered.map((other) => ({ season: other.season!, number: other.number! }));
    for (const other of covered) {
      other.manualMatch = { file, covers: other.season === null ? [] : matchCovers };
      if (other.branch !== 'paused' && other.branch !== 'cancelled' && other.reason !== null && (other.stage === 'validating' || other.stage === 'importing')) retry(other);
    }
    res.json({ ...preview_, done: true });
  };
}
