import { createHash } from 'node:crypto';
import { type Db, db } from '../../core/db.ts';
import { parseRelease } from './release.ts';
import { titleMatches } from './decide.ts';

// The reasons that ladarr gives when it blocks a release. The code is stable. The message is the key of the web i18n.
export const BLOCK_REASONS: Record<string, string> = {
  invalid_torrent: 'The indexer gave a file that is not a torrent.',
  invalid_magnet: 'The magnet link of the release is not valid.',
  no_download_link: 'The release has no download link.',
  pack_missing_episodes: 'The season pack does not hold all the episodes that it names.',
};

// The key of an entry is a hash, or an indexer and a GUID. A GUID can hold characters that a path does not allow, so the API uses a digest.
export const idOf = (key: string) => createHash('sha1').update(key).digest('hex');

type Entry = Db['data']['blocklist'][string];

// The title of an entry. An entry from a version that had no title for each entry is the title of its release.
export function ownerOf(entry: Entry, titles: Db['data']['titles']) {
  if (entry.titleKey) return entry.titleKey;
  const name = parseRelease(entry.title).title;
  for (const [key, title] of Object.entries(titles)) if (titleMatches(name, title)) return key;
  return null;
}

// The season of an entry. An entry from a version that had no season for each entry is the season of its release.
export const seasonOf = (entry: Entry) => entry.season ?? parseRelease(entry.title).season;

// Removes the entries of a title, or of one season of it, when the title or the season is removed.
export function clearBlocklist(titleKey: string, season?: number) {
  for (const [key, entry] of Object.entries(db.data.blocklist)) {
    if (ownerOf(entry, db.data.titles) !== titleKey) continue;
    if (season !== undefined && seasonOf(entry) !== season) continue;
    delete db.data.blocklist[key];
  }
}
