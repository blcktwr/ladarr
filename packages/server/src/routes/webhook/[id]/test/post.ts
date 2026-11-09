import type { RequestHandler } from 'express';
import type { Db } from '../../../../core/db.ts';
import { newEvent, send } from '../../../../core/webhook.ts';

// Tests a saved webhook, with the address of the server.
export function webhookTestSaved(db: Db): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const webhook = db.data.webhooks.find((item) => item.id === req.params.id);
    if (!webhook) return void res.status(404).json({ error: 'not_found' });
    res.json(await send(webhook.url, newEvent('test', Date.now())));
  };
}
