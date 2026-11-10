import { get } from '../../core/db.ts';
import type { BlocklistRow } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { BLOCK_REASONS, idOf, ownerOf } from '../../library/grab/blocklist.ts';

const MAX_PAGE = 200;

export function blocklistGet(): RequestHandler {
  const db = get();
  return (req, res) => {
    const limit = Math.min(Math.max(Math.trunc(Number(req.query.limit)) || 50, 1), MAX_PAGE);
    const offset = Math.max(Math.trunc(Number(req.query.offset)) || 0, 0);
    const titleKey = typeof req.query.titleKey === 'string' ? req.query.titleKey : null;
    const all = Object.entries(db.data.blocklist)
      .filter(([, entry]) => titleKey === null || ownerOf(entry, db.data.titles) === titleKey)
      .sort((a, b) => b[1].at - a[1].at || a[0].localeCompare(b[0]));
    const items: BlocklistRow[] = all.slice(offset, offset + limit).map(([key, entry]) => ({
      id: idOf(key),
      title: entry.title,
      reason: { code: entry.reason, message: BLOCK_REASONS[entry.reason] ?? 'This release was blocked.' },
      at: entry.at,
    }));
    res.json({ total: all.length, items });
  };
}
