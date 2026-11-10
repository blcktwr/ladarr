import { get } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { newEvent, send } from '../../../../core/webhook.ts';

// Tests a saved webhook, with the address of the server.
export function webhookTestSaved(): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const webhook = db.data.webhooks.find((item) => item.id === req.params.id);
    if (!webhook) return void res.status(404).json({ error: 'not_found' });
    res.json(await send(webhook.url, newEvent('test', Date.now())));
  };
}
