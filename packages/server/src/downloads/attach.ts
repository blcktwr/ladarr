import type { Queue, QueueEntry } from './queue.ts';
import type { ClientHandle, Torrent } from './qbittorrent.ts';

// Attaches a torrent that is in the client already to one or more targets. The HTTP route and the import verification
// both use it, so a manual attach and an automatic attach leave the same entry.
export async function attachTorrent(
  { queue }: { queue: Queue },
  { handle, torrent, targets, cause }: { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[]; cause: string },
): Promise<void> {
  const hash = torrent.hash;
  for (const target of targets) {
    queue.endAttempt(target, 'cancelled', 'replaced by an attached download');
    queue.startAttempt(target, 'attached download');
    target.release = {
      guid: `attached:${hash}`,
      indexerId: 0,
      indexerName: 'Download client',
      title: torrent.name,
      sizeBytes: torrent.sizeBytes,
      infoHash: hash,
      link: null,
      magnet: null,
      kind: targets.length > 1 ? 'pack' : 'single',
      seeders: null,
      manual: true,
      external: true,
    };
    const attempt = target.attempts.at(-1);
    if (attempt) attempt.release = torrent.name;
    // The old work of the target is gone. A search result, an import result, or a manual match of another download
    // must not stay next to the attached torrent.
    target.search = null;
    target.importResult = null;
    target.manualMatch = null;
    target.transferHash = hash;
    target.clientId = handle.id;
    queue.move(target, { stage: torrent.complete ? 'validating' : 'downloading', branch: null, reason: null }, cause, torrent.name);
  }
  // A partial torrent that the client keeps stopped never moves. The verification resumes it, so a restart of the
  // client or of ladarr does not leave the download dead.
  if (!torrent.complete && torrent.status === 'paused') await handle.api.setPaused(hash, false).catch(() => {});
}
