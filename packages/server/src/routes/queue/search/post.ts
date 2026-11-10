import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Finder } from '../../../library/grab/finder.ts';

export function queueSearchPost(finder: Finder): RequestHandler {
  return (req, res) => {
    const { titleKey, season, number } = (req.body ?? {}) as { titleKey?: unknown; season?: unknown; number?: unknown };
    const isNumber = (value: unknown) => value === undefined || (Number.isInteger(value) && (value as number) >= 0);
    if (typeof titleKey !== 'string' || !db.data.titles[titleKey] || !isNumber(season) || !isNumber(number)) return void res.status(400).json({ error: 'invalid_request' });
    // A request with a number is a target that the user selected. A movie is a target that the user selected too.
    const manual = number !== undefined || db.data.titles[titleKey]?.mediaType === 'movie';
    const started = finder.requestSearch(titleKey, { season: season as number | undefined, number: number as number | undefined, fresh: true, manual });
    res.status(202).json({ started: started.map((entry) => entry.id) });
  };
}
