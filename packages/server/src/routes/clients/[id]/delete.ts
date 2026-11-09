import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';

// The downloads of a client that is gone stay in the queue. The poller marks their numbers as old, as it does for a client that is off.
export function clientsDelete(db: Db, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const index = db.data.downloadClients.findIndex((item) => item.id === req.params.id);
    if (index < 0) return void res.status(404).json({ error: 'not_found' });
    db.data.downloadClients.splice(index, 1);
    await db.write();
    onChange();
    res.status(204).end();
  };
}
