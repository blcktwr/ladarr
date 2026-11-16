import { db } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { randomUUID } from 'node:crypto';
import { parse, view } from '../../helpers/webhook.ts';
import type { WebhookState } from '../../types.ts';

export function webhookCreate(): RequestHandler {
  return async (req, res) => {
    const parsed = parse(req.body);
    if ('field' in parsed) return void res.status(400).json({ error: 'invalid_setting', field: parsed.field });
    const webhook: WebhookState = { id: randomUUID(), ...parsed };
    db.data.webhooks.push(webhook);
    await db.write();
    res.status(201).json({ webhook: view(webhook) });
  };
}
