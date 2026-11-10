import { get } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { view } from '../../helpers/webhook.ts';

export function webhookGet(): RequestHandler {
  const db = get();
  return (_req, res) => void res.json({ webhooks: db.data.webhooks.map(view) });
}
