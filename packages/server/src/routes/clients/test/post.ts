import type { RequestHandler } from 'express';
import { parse, testClient } from '../../../helpers/clients.ts';

// A check of the settings of the form, before the user saves them.
export function clientsTest(): RequestHandler {
  return async (req, res) => {
    const result = parse(req.body);
    if ('invalid' in result) return void res.status(400).json({ error: 'invalid_setting', field: result.invalid });
    res.json(await testClient({ id: '', ...result.config }));
  };
}
