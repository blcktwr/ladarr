import { createHash } from 'node:crypto';
import type { BlocklistRow } from '@ladarr/shared/types';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import { parseRelease } from './release.ts';
import { titleMatches } from './decide.ts';

const MAX_PAGE = 200;

// The reasons that ladarr gives when it blocks a release. The code is stable. The message is the key of the web i18n.
export const BLOCK_REASONS: Record<string, string> = {
  invalid_torrent: 'The indexer gave a file that is not a torrent.',
  invalid_magnet: 'The magnet link of the release is not valid.',
  no_download_link: 'The release has no download link.',
  pack_missing_episodes: 'The season pack does not hold all the episodes that it names.',
};

// The key of an entry is a hash, or an indexer and a GUID. A GUID can hold characters that a path does not allow, so the API uses a digest.
const idOf = (key: string) => createHash('sha1').update(key).digest('hex');

type Entry = Db['data']['blocklist'][string];

// The title of an entry. An entry from a version that had no title for each entry is the title of its release.
function ownerOf(entry: Entry, titles: Db['data']['titles']) {
  if (entry.titleKey) return entry.titleKey;
  const name = parseRelease(entry.title).title;
  for (const [key, title] of Object.entries(titles)) if (titleMatches(name, title)) return key;
  return null;
}

// The season of an entry. An entry from a version that had no season for each entry is the season of its release.
const seasonOf = (entry: Entry) => entry.season ?? parseRelease(entry.title).season;

// Removes the entries of a title, or of one season of it, when the title or the season is removed.
export function clearBlocklist(db: Db, titleKey: string, season?: number) {
  for (const [key, entry] of Object.entries(db.data.blocklist)) {
    if (ownerOf(entry, db.data.titles) !== titleKey) continue;
    if (season !== undefined && seasonOf(entry) !== season) continue;
    delete db.data.blocklist[key];
  }
}

export function blocklistRouter(db: Db) {
  const router = Router();

  router.get('/', (req, res) => {
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
  });

  router.delete('/:id', async (req, res) => {
    const key = Object.keys(db.data.blocklist).find((item) => idOf(item) === req.params.id);
    if (key === undefined) return void res.status(404).json({ error: 'not_found' });
    delete db.data.blocklist[key];
    await db.write();
    res.json({ removed: 1 });
  });

  router.delete('/', async (req, res) => {
    const titleKey = typeof req.query.titleKey === 'string' ? req.query.titleKey : null;
    if (titleKey === null) {
      const removed = Object.keys(db.data.blocklist).length;
      db.data.blocklist = {};
      await db.write();
      return void res.json({ removed });
    }
    const keys = Object.keys(db.data.blocklist).filter((key) => ownerOf(db.data.blocklist[key]!, db.data.titles) === titleKey);
    for (const key of keys) delete db.data.blocklist[key];
    await db.write();
    res.json({ removed: keys.length });
  });

  return router;
}
