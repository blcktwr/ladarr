import type { RequestHandler } from 'express';
import type { Db } from '../../core/db.ts';
import { libraryFilter, libraryType, matchesType } from '../../library/tools/filters.ts';
import { summarize } from '../../library/tools/api.ts';

const MAX_PAGE = 100;

export function libraryGet(db: Db): RequestHandler {
  return (req, res) => {
    const type = libraryType(req.query.type);
    const q = typeof req.query.q === 'string' ? req.query.q.trim().toLowerCase() : '';
    const filter = libraryFilter(db, req.query.filter);
    if ('error' in filter) return void res.status(400).json({ error: filter.error });
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), MAX_PAGE);
    const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);

    const matches = Object.values(db.data.titles)
      .filter((title) => matchesType(title, type))
      .filter((title) => !q || title.meta.title.toLowerCase().includes(q) || title.meta.aliases.some((alias) => alias.toLowerCase().includes(q)))
      .filter(filter.test)
      .reverse()
      .sort((a, b) => b.addedAt - a.addedAt);
    // The summary needs the episodes of each series, so it is only worked out for the page.
    res.json({ items: matches.slice(offset, offset + limit).map((title) => summarize(db, title)), total: matches.length });
  };
}
