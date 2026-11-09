import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import type { Db } from '../../core/db.ts';
import type { WebhookState } from '../../core/webhook.ts';
import { parse, view } from '../../helpers/webhook.ts';

export function webhookCreate(db: Db): RequestHandler {
  return async (req, res) => {
    const parsed = parse(req.body);
    if ('field' in parsed) return void res.status(400).json({ error: 'invalid_setting', field: parsed.field });
    const webhook: WebhookState = { id: randomUUID(), ...parsed };
    db.data.webhooks.push(webhook);
    await db.write();
    res.status(201).json({ webhook: view(webhook) });
  };
}
