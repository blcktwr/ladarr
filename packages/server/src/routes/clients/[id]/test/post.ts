import { get } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { parse, testClient } from '../../../../helpers/clients.ts';

// Tests the saved client, or the settings of the body when it has some, before the user saves them.
export function clientsTestSaved(): RequestHandler<{ id: string }> {
  const db = get();
  return async (req, res) => {
    const config = db.data.downloadClients.find((item) => item.id === req.params.id);
    if (!config) return void res.status(404).json({ error: 'not_found' });
    if (typeof req.body !== 'object' || req.body === null || Array.isArray(req.body) || !Object.keys(req.body).length) return void res.json(await testClient(config));
    const result = parse(req.body, config);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    res.json(await testClient({ id: config.id, ...result.config }));
  };
}
