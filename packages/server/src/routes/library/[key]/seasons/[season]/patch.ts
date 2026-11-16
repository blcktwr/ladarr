import { db } from '../../../../../core/db.ts';
import type { RequestHandler } from 'express';
import { changed, detail, overrideOf } from '../../../../../helpers/library.ts';
import type { Events, Title } from '../../../../../types.ts';

export function librarySeasonUpdate({ events }: { events: Events }): RequestHandler<{ key: string; season: string }> {
  return async (req, res) => {
    const title: Title = res.locals.title;
    const override = overrideOf(req.body?.override);
    if (title.mediaType !== 'tv' || override === undefined || !/^\d+$/.test(req.params.season)) return void res.status(400).json({ error: 'invalid_override' });
    if (override) title.seasonOverrides[req.params.season] = override;
    else delete title.seasonOverrides[req.params.season];
    await changed(events, title.key);
    res.json({ title: detail(title) });
  };
}
