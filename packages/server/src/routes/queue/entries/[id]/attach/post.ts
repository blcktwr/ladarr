import { get } from '../../../../../core/db.ts';
import type { AttachPreview } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { Clients } from '../../../../../library/downloads/client-api.ts';
import { ClientError, type ClientHandle, type Torrent } from '../../../../../library/downloads/qbittorrent.ts';
import type { Queue } from '../../../../../library/downloads/queue.ts';
import { isActive } from '../../../../../library/downloads/queue.ts';
import { attachTorrent } from '../../../../../library/downloads/attach.ts';
import { attachRefusal, HASH, MAX_TARGETS } from '../../../../../helpers/queue-attach.ts';
import { label, shown } from '../../../../../helpers/queue.ts';

// Attaches a torrent that is in the client already. The user confirms the owner and the title before anything changes.
export function queueEntryAttachPost(queue: Queue, clients: Clients): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const { hash: rawHash, ids, confirmOwner, confirmTitle, preview } = (req.body ?? {}) as { hash?: unknown; ids?: unknown; confirmOwner?: unknown; confirmTitle?: unknown; preview?: unknown };
    if (!entry || !shown(db, entry)) return void res.status(404).json({ error: 'not_found' });
    const hash = typeof rawHash === 'string' ? rawHash.toLowerCase() : '';
    if (!HASH.test(hash) || (ids !== undefined && (!Array.isArray(ids) || ids.length > MAX_TARGETS || !ids.every((id) => typeof id === 'string')))) return void res.status(400).json({ error: 'invalid_request' });
    if (!preview && (confirmOwner !== true || confirmTitle !== true)) return void res.status(400).json({ error: 'confirmation_required' });

    const targets = [entry];
    for (const id of (ids ?? []) as string[]) {
      const other = db.data.queue[id];
      if (!other || !shown(db, other) || other.titleKey !== entry.titleKey) return void res.status(400).json({ error: 'invalid_request' });
      if (!targets.includes(other)) targets.push(other);
    }
    const refused = () =>
      targets.flatMap((target) => {
        const reason = attachRefusal(target);
        return reason ? [{ id: target.id, reason }] : [];
      });
    const unsupported = refused();
    if (unsupported.length) return void res.status(409).json({ error: 'attach_not_supported', unsupported });

    const handles = clients.all();
    if (!handles.length) return void res.status(409).json({ error: 'client_missing' });
    let torrent: Torrent | undefined;
    let owner: ClientHandle | undefined;
    try {
      for (const handle of handles) {
        torrent = (await handle.api.byHashes([hash]))[0];
        if (torrent) {
          owner = handle;
          break;
        }
      }
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
    if (!torrent || !owner) return void res.status(404).json({ error: 'torrent_not_found' });
    // The client took time to answer. A target can have changed in that time, so the targets are checked again, and no wait follows.
    const changed = refused();
    if (changed.length) return void res.status(409).json({ error: 'attach_not_supported', unsupported: changed });
    if (Object.values(db.data.queue).some((other) => other.transferHash === hash && isActive(other) && other.titleKey !== entry.titleKey)) return void res.status(409).json({ error: 'torrent_in_use' });

    const summary: AttachPreview = { hash, name: torrent.name, affected: targets.map((target) => ({ id: target.id, label: label(db, target) })) };
    if (preview) return void res.json(summary);

    await attachTorrent({ queue }, { handle: owner, torrent, targets, cause: 'download attached by the user' });
    res.json({ ...summary, done: true });
  };
}
