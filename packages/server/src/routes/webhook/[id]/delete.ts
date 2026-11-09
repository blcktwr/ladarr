import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { DELIVER, type DeliveryPayload } from '../../../core/webhook.ts';

// The events that wait go with the webhook. Another webhook must not get them.
export function webhookDelete(db: Db): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const index = db.data.webhooks.findIndex((item) => item.id === req.params.id);
    if (index < 0) return void res.status(404).json({ error: 'not_found' });
    db.data.webhooks.splice(index, 1);
    for (const job of Object.values(db.data.jobs)) if (job.type === DELIVER && (job.payload as DeliveryPayload | null)?.webhookId === req.params.id) delete db.data.jobs[job.id];
    await db.write();
    res.status(204).end();
  };
}
