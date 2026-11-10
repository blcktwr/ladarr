import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { savePush, summarize } from '../../../library/grab/indexers.ts';
import { exists, invalidSetting, parseManual, setDelay } from '../../../helpers/indexers.ts';

export function indexersUpdate({ onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer?.manual) return void res.status(404).json({ error: 'not_found' });
    const result = parseManual(req.body, indexer);
    if ('invalid' in result) return invalidSetting(res, result.invalid);
    if (exists(result.parsed.sonarr, indexer.id)) return void res.status(409).json({ error: 'exists' });
    savePush('sonarr', result.parsed.sonarr, indexer.id);
    savePush('radarr', result.parsed.radarr, indexer.id);
    indexer.manual = true;
    indexer.preferredLanguages = result.preferredLanguages;
    setDelay(indexer, result.delaySeconds);
    await db.write();
    onChange();
    res.json({ indexer: summarize(indexer) });
  };
}
