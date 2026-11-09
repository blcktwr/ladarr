import type { RequestHandler } from 'express';
import type { Finder } from '../../../library/grab/finder.ts';
import type { Db } from '../../../core/db.ts';

export function queueSearchPost(db: Db, finder: Finder): RequestHandler {
  return (req, res) => {
    const { titleKey, season, number } = (req.body ?? {}) as { titleKey?: unknown; season?: unknown; number?: unknown };
    const isNumber = (value: unknown) => value === undefined || (Number.isInteger(value) && (value as number) >= 0);
    if (typeof titleKey !== 'string' || !db.data.titles[titleKey] || !isNumber(season) || !isNumber(number)) return void res.status(400).json({ error: 'invalid_request' });
    // A request with a number is a target that the user selected. Its individual query runs whatever the age of the episode.
    const started = finder.requestSearch(titleKey, { season: season as number | undefined, number: number as number | undefined, fresh: true, manual: number !== undefined });
    res.status(202).json({ started: started.map((entry) => entry.id) });
  };
}
