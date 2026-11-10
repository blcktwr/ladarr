import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { parse, view } from '../../../helpers/webhook.ts';

export function webhookUpdate(): RequestHandler<{ id: string }> {
  const db = get();
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
