import type { RequestHandler } from 'express';
import { newEvent, send } from '../../../core/webhook.ts';
import { parseUrl } from '../../../helpers/webhook.ts';

// Sends a test event to an address that is not saved. It saves nothing.
export function webhookTest(): RequestHandler {
  return async (req, res) => {
    const url = parseUrl(req.body?.url);
    if (!url) return void res.status(400).json({ error: 'invalid_setting', field: 'url' });
    res.json(await send(url, newEvent('test', Date.now())));
  };
}
