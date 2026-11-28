import { isActiveState } from '@ladarr/shared/queue';
import type { Data, QueueTorrent, QueueTurn, RejectedRelease } from '../../types.ts';
import { REJECTION_TEXT } from './rejections.ts';
import { parseRelease } from './release.ts';

function row({ hash, release, matches }: QueueTorrent): RejectedRelease {
  const { resolution, source } = parseRelease(release.title);
  const files = Object.entries(matches).filter((match): match is [string, string] => Boolean(match[1]));
  const { indexerId, guid, title, link, magnet, sizeBytes, seeders, kind } = release;
  return { indexerId, guid, title, link, magnet, infoHash: hash, sizeBytes, seeders, kind, resolution, source,
    reasons: [REJECTION_TEXT.pack_partial!], sizeRejection: null, manifestProblem: 'pack_partial',
    ...(files.length ? { matches: Object.fromEntries(files) } : {}) };
}

// A season that stops keeps no release that a search chose: the releases do not hold every episode that it needs. They
// go to the rejected list, for the manual mapping. A release or a file that the user chose stays.
export function detach(data: Data, item: QueueTurn) {
  const chosen = Object.values(item.selected).filter(({ status, release, sendMapped, manualMatches }) =>
    status === 'prepared' && !release.manual && !sendMapped && !manualMatches);
  const entries = chosen.flatMap(({ hash, matches }) => Object.keys(matches).flatMap((id) => {
    const entry = data.queue[id];
    return entry && isActiveState(entry.state) && entry.transferHash === hash ? [entry] : [];
  }));
  for (const entry of entries) Object.assign(entry, { release: null, transferHash: null, clientId: null, source: null });
  item.selected = Object.fromEntries(Object.entries(item.selected).filter(([, torrent]) => !chosen.includes(torrent)));
  return { entries, hashes: chosen.map(({ hash }) => hash), rows: chosen.map(row) };
}
