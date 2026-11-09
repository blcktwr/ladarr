import { randomUUID } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.ts';
import type { ClientConfig } from '../../library/downloads/qbittorrent.ts';
import { parse, view } from '../../helpers/clients.ts';

export function clientsCreate(db: Db, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler {
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
