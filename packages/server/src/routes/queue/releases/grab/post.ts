import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { REJECTION_TEXT } from '../../../../library/grab/decide.ts';
import { catalogTargets } from '../../../../helpers/queue.ts';
import type { Finder, Queue } from '../../../../types.ts';

export function queueReleaseGrabPost(queue: Queue, finder: Finder): RequestHandler {
  return async (req, res) => {
    const { titleKey, season, number, indexerId, guid, ids } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof titleKey !== 'string' || typeof guid !== 'string' || typeof indexerId !== 'number' || !db.data.titles[titleKey]) return void res.status(400).json({ error: 'invalid_request' });
    const title = db.data.titles[titleKey]!;
    const catalog = catalogTargets(title);
    let targets: [number | null, number | null][];
    if (title.mediaType === 'movie') {
      if (ids !== undefined && (!Array.isArray(ids) || ids.length !== 1 || ids[0] !== titleKey)) return void res.status(400).json({ error: 'invalid_request' });
      targets = [[null, null]];
    } else if (ids !== undefined) {
      if (!Array.isArray(ids) || !ids.length || ids.length > 1000 || !ids.every((id) => typeof id === 'string' && catalog.some((target) => target.id === id))) return void res.status(400).json({ error: 'invalid_request' });
      targets = [...new Set(ids)].map((id) => {
        const target = catalog.find((item) => item.id === id)!;
        return [target.season, target.number];
      });
    } else if (Number.isInteger(season) && Number.isInteger(number) && catalog.some((target) => target.season === season && target.number === number)) targets = [[season as number, number as number]];
    else return void res.status(400).json({ error: 'invalid_request' });
    const result = await finder.interactive(titleKey, { season: season as number | undefined, number: number as number | undefined }, AbortSignal.timeout(10 * 60_000));
    const found = result?.decisions.find(({ decision }) => decision.release.guid === guid && decision.release.indexerId === indexerId);
    if (!found) return void res.status(404).json({ error: 'release_not_found' });
    const { want, decision } = found;
    const entries = targets.map(([s, n]) => queue.ensure(titleKey, s, n));
    const outcome = finder.grabManual(entries, decision.release, want);
    if (!('reserved' in outcome)) return void res.status(409).json({ error: 'release_rejected', rejections: outcome.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })) });
    res.status(202).json({ started: entries.map((entry) => entry.id) });
  };
}
