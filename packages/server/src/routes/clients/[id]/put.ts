import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { parse, view } from '../../../helpers/clients.ts';

export function clientsUpdate(db: Db, { onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const config = db.data.downloadClients.find((item) => item.id === req.params.id);
    if (!config) return void res.status(404).json({ error: 'not_found' });
    const result = parse(req.body, config);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    Object.assign(config, result.config);
    await db.write();
    onChange();
    res.json({ client: view(config) });
  };
}
