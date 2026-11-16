import { isActive, type Queue, type QueueEntry, type ReleaseRef } from './queue.ts';
import type { ClientHandle, Torrent } from './qbittorrent.ts';

// Records the torrent of a target: the release that it shows, the hash, and the client that has it. The caller moves
// the phase, because an attached download and a file that is already in the library are different steps.
export function recordTorrent(
  entry: QueueEntry,
  { handle, torrent, kind, external }: { handle: ClientHandle; torrent: Torrent; kind: ReleaseRef['kind']; external: boolean },
): void {
  entry.release = {
    guid: `attached:${torrent.hash}`,
    indexerId: 0,
    indexerName: 'Download client',
    title: torrent.name,
    sizeBytes: torrent.sizeBytes,
    infoHash: torrent.hash,
    link: null,
    magnet: null,
    kind,
    seeders: null,
    manual: true,
    external,
  };
  const attempt = entry.attempts.at(-1);
  if (attempt) attempt.release = torrent.name;
  entry.transferHash = torrent.hash;
  entry.clientId = handle.id;
}

// Attaches a torrent that is in the client already to one or more targets. The HTTP route and the import verification
// both use it, so a manual attach and an automatic attach leave the same entry.
export async function attachTorrent(
  { queue }: { queue: Queue },
  { handle, torrent, targets, cause }: { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[]; cause: string },
): Promise<void> {
  const hash = torrent.hash;
  for (const target of targets) {
    // A cancelled or completed target stays as it is. A late attach must not revive it.
    if (!isActive(target)) continue;
    queue.endAttempt(target, 'cancelled', 'replaced by an attached download');
    queue.startAttempt(target, 'attached download');
    recordTorrent(target, { handle, torrent, kind: targets.length > 1 ? 'pack' : 'single', external: true });
    // The old work of the target is gone. A search result, an import result, or a manual match of another download
    // must not stay next to the attached torrent.
    target.search = null;
    target.importResult = null;
    target.manualMatch = null;
    queue.enter(target, torrent.complete ? 'validating' : 'downloading', cause, torrent.name);
  }
  // A partial torrent that the client keeps stopped never moves. The verification resumes it, so a restart of the
  // client or of ladarr does not leave the download dead.
  if (!torrent.complete && torrent.status === 'paused') await handle.api.setPaused(hash, false).catch(() => {});
}
