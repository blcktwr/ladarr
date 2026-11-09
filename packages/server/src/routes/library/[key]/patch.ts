import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import type { Events } from '../../../core/events.ts';
import type { EnqueueInput, Job } from '../../../core/jobs.ts';
import type { Title } from '../../../library/library.ts';
import { requestVerification } from '../../../library/verification.ts';
import { changed, detail, isObject } from '../../../helpers/library.ts';

type Deps = { events: Events; enqueue: (input: EnqueueInput) => Job };

const hasFiles = (title: Title) => Boolean(title.fileId) || title.episodes.some((episode) => episode.fileId);

export function libraryTitleUpdate(db: Db, { events, enqueue }: Deps): RequestHandler<{ key: string }> {
  return async (req, res) => {
    const title: Title = res.locals.title;
    const body = req.body;
    if (!isObject(body)) return void res.status(400).json({ error: 'invalid_title_change' });
    const series = title.mediaType === 'tv';
    const next: Partial<Title> = {};
    for (const [field, value] of Object.entries(body)) {
      if (field === 'paused' && typeof value === 'boolean') next.paused = value;
      else if (field === 'policy' && series && (value === 'all' || value === 'future')) {
        next.policy = value;
        // Future episodes counts from the moment the user chooses it.
        if (value === 'future' && title.policy !== 'future') next.futureFrom = Date.now();
      } else if (field === 'seriesType' && series && (value === 'standard' || value === 'anime')) next.seriesType = value;
      else if (field === 'preset' && (value === null || (typeof value === 'string' && Object.hasOwn(db.data.profiles, value)))) next.preset = value;
      else if (field === 'manualRelease' && !series && typeof value === 'boolean') next.manualRelease = value;
      else if (field === 'rootId' && typeof value === 'string' && db.data.roots[value]?.mediaType === title.mediaType) {
        // Moving files between roots is a different action with a preview.
        if (value !== title.rootId && hasFiles(title)) return void res.status(409).json({ error: 'files_exist' });
        next.rootId = value;
      } else return void res.status(400).json({ error: 'invalid_title_change', field });
    }
    const wasPaused = title.paused;
    Object.assign(title, next);
    // A resume checks the folder, the client, and the queue, and starts the search for the old missing targets. The
    // search of a title that the user paused has never run for them.
    if (wasPaused && !title.paused) requestVerification(db, enqueue, title.key, {});
    await changed(db, events, title.key);
    res.json({ title: detail(db, title) });
  };
}
