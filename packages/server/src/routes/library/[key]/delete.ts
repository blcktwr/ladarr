import { db } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import { dropTitle } from '../../../library/tools/remove.ts';
import { changed } from '../../../helpers/library.ts';
import type { DeleteDeps, Title } from '../../../types.ts';

// The record goes away. The files stay where they are.
export function libraryTitleDelete({ events, queue, cancelJob }: DeleteDeps): RequestHandler<{ key: string }> {
  return async (_req, res) => {
    const title: Title = res.locals.title;
    // An unfinished import needs its title to end.
    if (Object.values(db.data.imports).some((journal) => journal.titleKey === title.key)) return void res.status(409).json({ error: 'import_running' });
    dropTitle(title.key, queue, cancelJob);
    await changed(events, title.key);
    res.json({ ok: true });
  };
}
