import { db } from '../../core/db.ts';
import { normalizeNumbering } from '../numbering.ts';
import { forgetSource, isActive } from './queue.ts';
import type { ClientHandle, Queue, QueueEntry, ReleaseRef, Torrent } from '../../types.ts';

// Records the torrent of a target: the release that it shows, the hash, and the client that has it. The caller moves
// the phase, because an attached download and a file that is already in the library are different steps.
export function recordTorrent(
  entry: QueueEntry,
  { handle, torrent, kind, external }: { handle: ClientHandle; torrent: Torrent; kind: ReleaseRef['kind']; external: boolean },
): void {
  if (entry.release?.uploadPath && entry.source) forgetSource(entry);
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
  // The torrent is in the client, so a source that waited for a slot is no longer needed.
  forgetSource(entry);
  entry.importTries = 0;
}

// Attaches a torrent that is in the client already to one or more targets. The HTTP route and the import verification
// both use it, so a manual attach and an automatic attach leave the same entry.
export async function attachTorrent(
  { queue }: { queue: Queue },
  { handle, torrent, targets, cause, manual = false, external = true }: { handle: ClientHandle; torrent: Torrent; targets: QueueEntry[]; cause: string; manual?: boolean; external?: boolean },
): Promise<void> {
  const hash = torrent.hash;
  let attached = false;
  for (const target of targets) {
    // A cancelled or completed target stays as it is. A late attach must not revive it.
    if (target.release?.uploadPath || !isActive(target) || target.state.kind === 'paused' || (target.state.kind === 'blocked' && !manual)) continue;
    queue.endAttempt(target, 'cancelled', 'replaced by an attached download');
    queue.startAttempt(target, 'attached download');
    recordTorrent(target, { handle, torrent, kind: targets.length > 1 ? 'pack' : 'single', external });
    // A torrent that the user attaches enters the acquisition with the numbering of the title now. A target that has a
    // snapshot already keeps it, so a restart does not reinterpret its download.
    if (target.numbering === undefined) target.numbering = structuredClone(normalizeNumbering(db.data.titles[target.titleKey]?.numbering));
    // The old work of the target is gone. A search result, an import result, or a manual match of another download
    // must not stay next to the attached torrent.
    target.search = null;
    target.importResult = null;
    target.manualMatch = null;
    if (manual) queue.resolve(target, torrent.complete ? 'importing' : 'downloading', cause, torrent.name);
    else queue.enter(target, torrent.complete ? 'importing' : 'downloading', cause, torrent.name);
    attached = true;
  }
  // A partial torrent that the client keeps stopped never moves. The verification resumes it, so a restart of the
  // client or of ladarr does not leave the download dead.
  if (attached && !torrent.complete && torrent.status === 'paused') await handle.api.setPaused(hash, false).catch(() => {});
}
