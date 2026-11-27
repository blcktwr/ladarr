import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { validReleaseDayMinutes } from '@ladarr/shared/indexers';
import { MAX_DELAY_SECONDS, isLanguageList, summarize } from '../../../library/grab/indexers.ts';
import { invalidSetting, setDelay, setReleaseDayMinutes } from '../../../helpers/indexers.ts';
import type { Finder } from '../../../types.ts';

export function indexersPatch(reschedule?: Finder['rescheduleReleaseDay']): RequestHandler<{ id: string }> {
  return async (req, res) => {
    const indexer = db.data.indexers[Number(req.params.id)];
    if (!indexer) return void res.status(404).json({ error: 'not_found' });
    const body = (req.body ?? {}) as { delaySeconds?: unknown; releaseDayMinutes?: unknown; preferredLanguages?: unknown; rejectZeroSeeders?: unknown };
    const delaySeconds = body.delaySeconds === undefined && body.releaseDayMinutes !== undefined ? indexer.delaySeconds : body.delaySeconds;
    if (typeof delaySeconds !== 'number' || !Number.isFinite(delaySeconds) || delaySeconds < 0 || delaySeconds > MAX_DELAY_SECONDS)
      return invalidSetting(res, 'delaySeconds');
    if (body.releaseDayMinutes !== undefined && !validReleaseDayMinutes(body.releaseDayMinutes)) return invalidSetting(res, 'releaseDayMinutes');
    if (body.rejectZeroSeeders !== undefined && typeof body.rejectZeroSeeders !== 'boolean') return invalidSetting(res, 'rejectZeroSeeders');
    if (body.preferredLanguages !== undefined && !isLanguageList(body.preferredLanguages)) return invalidSetting(res, 'preferredLanguages');
    if (body.releaseDayMinutes !== undefined) setReleaseDayMinutes(indexer, body.releaseDayMinutes, reschedule);
    if (body.rejectZeroSeeders !== undefined) indexer.rejectZeroSeeders = body.rejectZeroSeeders;
    if (body.preferredLanguages !== undefined) indexer.preferredLanguages = [...new Set(body.preferredLanguages)];
    setDelay(indexer, delaySeconds);
    await db.write();
    res.json({ indexer: summarize(indexer) });
  };
}
