import { db } from '../../../../../core/db.ts';
import type { AttachCandidates } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { ClientError } from '../../../../../library/downloads/qbittorrent.ts';
import { attachCandidates, attachRefusal, downloadsOf } from '../../../../../helpers/queue-attach.ts';
import { label, shown } from '../../../../../helpers/queue.ts';
import type { Clients } from '../../../../../types.ts';

// The torrents of the client that the user can attach to the target, and the targets that can share the download.
export function queueEntryExternalGet(clients: Clients): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const entry = db.data.queue[req.params.id];
    const handles = clients.all();
    if (!entry || !shown(entry)) return void res.status(404).json({ error: 'not_found' });
    const mapping = req.query.mapping === 'true' && entry.season !== null && entry.state.kind === 'blocked';
    const refusal = mapping ? null : attachRefusal(entry);
    if (refusal) return void res.status(409).json({ error: 'attach_not_supported', reason: refusal });
    if (!handles.length) return void res.status(409).json({ error: 'client_missing' });
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    try {
      const candidates = await attachCandidates(handles, entry.titleKey, mapping, q, mapping ? downloadsOf(entry.titleKey) : undefined);
      const siblings = mapping || entry.season === null
        ? []
        : Object.values(db.data.queue).filter((other) => other.id !== entry.id && other.titleKey === entry.titleKey && other.season === entry.season && shown(other) && attachRefusal(other) === null);
      const body: AttachCandidates = {
        ...candidates,
        siblings: siblings.sort((a, b) => (a.number ?? 0) - (b.number ?? 0)).map((other) => ({ id: other.id, label: label(other) })),
      };
      res.json(body);
    } catch (error) {
      if (error instanceof ClientError) return void res.status(502).json({ error: 'client_unreachable' });
      throw error;
    }
  };
}
