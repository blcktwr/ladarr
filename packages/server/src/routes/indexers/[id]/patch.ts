import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { MAX_DELAY_SECONDS, isLanguageList, summarize } from '../../../library/grab/indexers.ts';
import { invalidSetting, setDelay } from '../../../helpers/indexers.ts';

export function indexersPatch(): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer) return void res.status(404).json({ error: 'not_found' });
    const body = (req.body ?? {}) as { delaySeconds?: unknown; preferredLanguages?: unknown };
    if (typeof body.delaySeconds !== 'number' || !Number.isFinite(body.delaySeconds) || body.delaySeconds < 0 || body.delaySeconds > MAX_DELAY_SECONDS)
      return invalidSetting(res, 'delaySeconds');
    if (body.preferredLanguages !== undefined) {
      if (!isLanguageList(body.preferredLanguages)) return invalidSetting(res, 'preferredLanguages');
      indexer.preferredLanguages = [...new Set(body.preferredLanguages)];
    }
    setDelay(indexer, body.delaySeconds);
    await db.write();
    res.json({ indexer: summarize(indexer) });
  };
}
