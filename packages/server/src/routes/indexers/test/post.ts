import type { RequestHandler } from 'express';
import type { IndexerService } from '../../../library/grab/torznab.ts';
import { draft, invalidSetting, parseManual, probe } from '../../../helpers/indexers.ts';

// A check of the settings of the form, before the user saves them.
export function indexersTest(service: IndexerService): RequestHandler {
  return async (req, res) => {
    const result = parseManual(req.body);
    if ('invalid' in result) return invalidSetting(res, result.invalid);
    res.json(await probe(service, draft(result.parsed.sonarr, result.parsed.sonarr.apiKey!)));
  };
}
