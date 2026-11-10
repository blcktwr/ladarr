import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { REJECTION_TEXT } from '../../../library/grab/decide.ts';
import type { Finder } from '../../../library/grab/finder.ts';

// The releases for a target, with the reason for each rejection.
export function queueReleasesGet(finder: Finder): RequestHandler {
  return async (req, res) => {
    const titleKey = String(req.query.titleKey ?? '');
    const season = req.query.season === undefined ? undefined : Number(req.query.season);
    const number = req.query.number === undefined ? undefined : Number(req.query.number);
    if (!db.data.titles[titleKey] || (season !== undefined && !Number.isInteger(season)) || (number !== undefined && !Number.isInteger(number))) return void res.status(400).json({ error: 'invalid_request' });
    const result = await finder.interactive(titleKey, { season, number, fresh: req.query.fresh === '1' }, AbortSignal.timeout(10 * 60_000));
    if (!result) return void res.status(404).json({ error: 'not_found' });
    res.json({
      asked: result.asked,
      answered: result.answered,
      // A release of another title is noise: the indexer matched the words, and ladarr can never take it.
      releases: result.decisions
        .filter(({ decision }) => !decision.rejections.includes('wrong_title'))
        .map(({ decision, overridable }) => ({
          indexerId: decision.release.indexerId,
          guid: decision.release.guid,
          title: decision.release.title,
          indexer: db.data.indexers[decision.release.indexerId]?.push.sonarr?.name ?? db.data.indexers[decision.release.indexerId]?.push.radarr?.name ?? 'Indexer',
          sizeBytes: decision.release.sizeBytes,
          seeders: decision.release.seeders,
          kind: decision.kind,
          accepted: decision.accepted,
          overridable,
          rejections: decision.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })),
        }))
        .sort((a, b) => Number(b.accepted) - Number(a.accepted) || Number(b.overridable) - Number(a.overridable) || b.sizeBytes - a.sizeBytes),
    });
  };
}
