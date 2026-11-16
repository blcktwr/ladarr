import { db } from '../../../../../core/db.ts';
import type { QueueMatchPreview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { isActive } from '../../../../../library/downloads/queue.ts';
import { createRetry, sharingOf } from '../../../../../library/downloads/queue-api.ts';
import { listDownloadFiles } from '../../../../../library/imports/importer.ts';
import { titleFiles } from '../../../../../library/imports/local.ts';
import { label, shown } from '../../../../../helpers/queue.ts';
import type { Clients, Covered, EnqueueInput, Finder, Job, Queue, QueueEntry } from '../../../../../types.ts';

// Matches a file of the download to the target, or to several episodes. The match stays through every retry.
// A target that has no torrent takes a file of the folder of its title, and the local import runs again.
export function queueEntryMatchPost(queue: Queue, finder: Finder, clients: Clients, enqueue: (input: EnqueueInput) => Job): RequestHandler<{ id: string }> {
  const { retry } = createRetry({ queue, enqueue });
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { file, covers, preview } = (req.body ?? {}) as { file?: unknown; covers?: unknown; preview?: boolean };
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    if (typeof file !== 'string') return void res.status(400).json({ error: 'invalid_request' });

    // The target has no download. Its file is one of the folder of its title, and the import reads the folder again.
    if (!entry.transferHash) {
      const title = db.data.titles[entry.titleKey];
      if (!title) return void res.status(404).json({ error: 'not_found' });
      const folder = await titleFiles(title);
      if (folder.status === 'root_unavailable') return void res.status(409).json({ error: 'root_unavailable' });
      // The path comes from the user, so it must be one of the files of this title. A file of another title is refused.
      if (!folder.files.some((item) => item.rel === file)) return void res.status(400).json({ error: 'file_not_in_title' });

      const targets = Object.values(db.data.queue).filter((other) => other.titleKey === entry.titleKey && other.attempt > 0 && isActive(other));
      let covered: QueueEntry[] = [entry];
      if (covers !== undefined) {
        const list = covers as Covered[];
        if (!Array.isArray(list) || list.length > 50 || !list.every((c) => Number.isInteger(c?.season) && Number.isInteger(c?.number))) return void res.status(400).json({ error: 'invalid_request' });
        covered = targets.filter((other) => other.season !== null && list.some((c) => c.season === other.season && c.number === other.number));
        // A cover that the title does not have is an error. It is not dropped without a word.
        if (list.some((c) => !covered.some((other) => other.season === c.season && other.number === c.number) && !(entry.season === c.season && entry.number === c.number))) return void res.status(400).json({ error: 'cover_not_in_download' });
        if (!covered.includes(entry)) covered.push(entry);
      }

      // The targets that lose the file because another target takes it.
      const taken = targets.filter((other) => other.id !== entry.id && other.manualMatch?.file === file && !covered.includes(other));
      const preview_: QueueMatchPreview = {
        file,
        affected: covered.map((other) => ({ id: other.id, label: label(other), current: other.manualMatch?.file ?? null })),
        replaces: taken.map((other) => ({ id: other.id, label: label(other) })),
        retries: covered.filter((other) => other.state.kind === 'blocked' && other.state.at === 'importing').map((other) => ({ id: other.id, label: label(other) })),
      };
      if (preview) return void res.json(preview_);

      for (const other of taken) other.manualMatch = null;
      const matchCovers = covered.map((other) => ({ season: other.season!, number: other.number! }));
      for (const other of covered) {
        other.manualMatch = { file, covers: other.season === null ? [] : matchCovers };
        queue.touch(other);
      }
      enqueue({ type: 'import.local', payload: { titleKey: entry.titleKey }, dedupeKey: `local:${entry.titleKey}`, priority: entry.priority !== null });
      return void res.json({ ...preview_, done: true });
    }

    const handle = clients.get(entry.clientId);
    if (!handle) return void res.status(409).json({ error: 'client_missing' });
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
      retries: covered.filter((other) => other.state.kind === 'blocked' && other.state.at === 'importing').map((other) => ({ id: other.id, label: label(other) })),
    };
    if (preview) return void res.json(preview_);

    for (const other of taken) other.manualMatch = null;
    const matchCovers = covered.map((other) => ({ season: other.season!, number: other.number! }));
    for (const other of covered) {
      other.manualMatch = { file, covers: other.season === null ? [] : matchCovers };
      if (other.state.kind === 'blocked' && other.state.at === 'importing') retry(other);
    }
    res.json({ ...preview_, done: true });
  };
}
