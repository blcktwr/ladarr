import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { parse, view } from '../../../helpers/webhook.ts';

export function webhookUpdate(db: Db): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const webhook = db.data.webhooks.find((item) => item.id === req.params.id);
    if (!webhook) return void res.status(404).json({ error: 'not_found' });
    const parsed = parse(req.body);
    if ('field' in parsed) return void res.status(400).json({ error: 'invalid_setting', field: parsed.field });
    Object.assign(webhook, parsed);
    await db.write();
    res.json({ webhook: view(webhook) });
  };
}
