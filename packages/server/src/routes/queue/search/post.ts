import { db } from '../../../core/db.ts';
import { seasonGroups } from '../../../helpers/library.ts';
import { entryId } from '../../../library/downloads/queue.ts';
import type { RequestHandler } from 'express';
import type { Finder } from '../../../types.ts';

export function queueSearchPost(finder: Finder): RequestHandler {
  return (req, res) => {
    const { titleKey, season, number, numberingRevision } = (req.body ?? {}) as { titleKey?: unknown; season?: unknown; number?: unknown; numberingRevision?: unknown };
    const isNumber = (value: unknown) => value === undefined || (Number.isInteger(value) && (value as number) >= 0);
    if (typeof titleKey !== 'string' || !db.data.titles[titleKey] || !isNumber(season) || !isNumber(number)) return void res.status(400).json({ error: 'invalid_request' });
    // A request with a number is a target that the user selected. A movie is a target that the user selected too.
    const manual = number !== undefined || db.data.titles[titleKey]?.mediaType === 'movie';
    let only: Set<string> | undefined;
    if (numberingRevision !== undefined) {
      const title = db.data.titles[titleKey]!;
      if (title.mediaType !== 'tv' || typeof season !== 'number' || number !== undefined) return void res.status(400).json({ error: 'invalid_request' });
      if (numberingRevision !== title.numbering?.revision) return void res.status(409).json({ error: 'numbering_changed' });
      const rows = seasonGroups(title).get(season);
      if (!rows) return void res.status(400).json({ error: 'invalid_season' });
      only = new Set(rows.map(({ episode }) => entryId(titleKey, episode.season, episode.number)));
    }
    const started = finder.requestSearch(titleKey, { season: only ? undefined : season as number | undefined, number: number as number | undefined, only, fresh: true, manual });
    res.status(202).json({ started: started.map((entry) => entry.id) });
  };
}
