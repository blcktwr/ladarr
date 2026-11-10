import { db } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { REJECTION_TEXT } from '../../../../library/grab/decide.ts';
import type { Finder } from '../../../../library/grab/finder.ts';
import type { Queue } from '../../../../library/downloads/queue.ts';

export function queueReleaseGrabPost(queue: Queue, finder: Finder): RequestHandler {
  return async (req, res) => {
    const { titleKey, season, number, indexerId, guid } = (req.body ?? {}) as Record<string, unknown>;
    if (typeof titleKey !== 'string' || typeof guid !== 'string' || typeof indexerId !== 'number' || !db.data.titles[titleKey]) return void res.status(400).json({ error: 'invalid_request' });
    const result = await finder.interactive(titleKey, { season: season as number | undefined, number: number as number | undefined }, AbortSignal.timeout(10 * 60_000));
    const found = result?.decisions.find(({ decision }) => decision.release.guid === guid && decision.release.indexerId === indexerId);
    if (!found) return void res.status(404).json({ error: 'release_not_found' });
    const { want, decision } = found;
    const title = db.data.titles[titleKey]!;
    const targets: [number | null, number | null][] =
      want.kind === 'movie' ? [[null, null]] : want.kind === 'episode' ? [[want.season, want.number]] : decision.covers.filter((c) => title.episodes.some((e) => e.season === c.season && e.number === c.number)).map((c) => [c.season, c.number]);
    const entries = targets.map(([s, n]) => queue.ensure(titleKey, s, n));
    const outcome = finder.grabManual(entries, decision.release, want);
    if (!('reserved' in outcome)) return void res.status(409).json({ error: 'release_rejected', rejections: outcome.rejections.map((code) => ({ code, message: REJECTION_TEXT[code] ?? code })) });
    res.status(202).json({ started: entries.map((entry) => entry.id) });
  };
}
