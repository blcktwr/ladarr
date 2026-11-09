import type { RequestHandler } from 'express';
import type { Db } from '../../../../../../core/db.ts';
import type { Events } from '../../../../../../core/events.ts';
import type { Title } from '../../../../../../library/library.ts';
import { changed, detail, overrideOf } from '../../../../../../helpers/library.ts';

export function libraryEpisodeUpdate(db: Db, { events }: { events: Events }): RequestHandler<{ key: string; season: string; number: string }> {
  return async (req, res) => {
    const title: Title = res.locals.title;
    const override = overrideOf(req.body?.override);
    const episode = title.episodes.find((e) => e.season === Number(req.params.season) && e.number === Number(req.params.number));
    if (!episode) return void res.status(404).json({ error: 'not_found' });
    if (override === undefined) return void res.status(400).json({ error: 'invalid_override' });
    episode.override = override;
    await changed(db, events, title.key);
    res.json({ title: detail(db, title) });
  };
}
