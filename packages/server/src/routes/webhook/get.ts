import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.ts';
import { view } from '../../helpers/webhook.ts';

export function webhookGet(db: Db): RequestHandler {
  return (_req, res) => void res.json({ webhooks: db.data.webhooks.map(view) });
}
