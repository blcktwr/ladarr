import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { identity, isObject } from '../../../../library/grab/indexers.ts';
import type { IndexerService } from '../../../../library/grab/torznab.ts';
import { draft, invalidSetting, parseManual, probe } from '../../../../helpers/indexers.ts';

// Tests the saved indexer, or the settings of the body when it has some, before the user saves them.
export function indexerTestSaved(service: IndexerService): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer) return void res.status(404).json({ error: 'not_found' });
    if (!isObject(req.body) || !Object.keys(req.body).length) return void res.json(await probe(service, indexer));
    if (!indexer.manual) return void res.status(404).json({ error: 'not_found' });
    const result = parseManual(req.body, indexer);
    if ('invalid' in result) return invalidSetting(res, result.invalid);
    const probeDraft = draft(result.parsed.sonarr, result.parsed.sonarr.apiKey ?? indexer.apiKey);
    // The same address waits in the queue of the saved indexer, so the test respects its delay.
    if (identity(probeDraft.baseUrl, probeDraft.apiPath) === identity(indexer.baseUrl, indexer.apiPath)) probeDraft.id = indexer.id;
    res.json(await probe(service, probeDraft));
  };
}
