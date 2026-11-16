import { db } from '../../core/db.ts';
import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import { parse, view } from '../../helpers/clients.ts';
import type { ClientConfig } from '../../types.ts';

export function clientsCreate({ onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler {
  return async (req, res) => {
    const result = parse(req.body);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    const config: ClientConfig = { id: randomUUID(), ...result.config };
    db.data.downloadClients.push(config);
    await db.write();
    onChange();
    res.status(201).json({ client: view(config) });
  };
}
