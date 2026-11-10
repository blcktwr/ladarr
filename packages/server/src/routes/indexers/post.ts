import { db } from '../../core/db.ts';
import type { RequestHandler } from 'express';
import { savePush, summarize } from '../../library/grab/indexers.ts';
import { exists, invalidSetting, parseManual, setDelay } from '../../helpers/indexers.ts';

export function indexersCreate({ onChange = () => {} }: { onChange?: () => void } = {}): RequestHandler {
  return async (req, res) => {
    const result = parseManual(req.body);
    if ('invalid' in result) return invalidSetting(res, result.invalid);
    if (exists(result.parsed.sonarr)) return void res.status(409).json({ error: 'exists' });
    const indexer = savePush('sonarr', result.parsed.sonarr)!;
    savePush('radarr', result.parsed.radarr);
    indexer.manual = true;
    indexer.preferredLanguages = result.preferredLanguages;
    setDelay(indexer, result.delaySeconds);
    await db.write();
    onChange();
    res.status(201).json({ indexer: summarize(indexer) });
  };
}
