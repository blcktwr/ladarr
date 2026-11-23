import type { EpisodeRef } from '../../types.ts';
import { parseEpisodes } from '../parse.ts';

const seasonFolder = /^(?:season|temporada|s)[ ._-]*(\d+)$/i;
const extras = /(?:^|[ ._-])(?:extras?|specials?|bonus|featurettes?|trailers?|ncop\d*|nced\d*)(?:$|[ ._-])/i;

export function folderMapping(paths: string[], episodes: EpisodeRef[]) {
  const catalog = episodes.filter(({ season }) => season > 0).sort((a, b) => a.season - b.season || a.number - b.number);
  const groups = new Map<number, { folder: string; path: string; season: number | null; number: number | null }[]>();
  const assignments = new Map<string, EpisodeRef[]>();
  for (const path of paths) {
    const parts = path.split('/');
    if (parts.slice(1).some((part) => extras.test(part.replace(/\.[^.]+$/, '')))) continue;
    const index = parts.slice(0, -1).findLastIndex((part) => seasonFolder.test(part));
    if (index < 0) continue;
    const season = Number(seasonFolder.exec(parts[index]!)![1]);
    if (!Number.isSafeInteger(season) || season < 1) continue;
    const read = parseEpisodes(parts.at(-1)!, season);
    const number = read?.numbers.length === 1 ? read.numbers[0]! : null;
    const group = groups.get(season) ?? [];
    group.push({ folder: parts.slice(0, index + 1).join('/'), path, season: read?.season ?? null, number });
    groups.set(season, group);
  }
  let offset = 0;
  let previous = 0;
  for (const [season, group] of [...groups].sort(([a], [b]) => a - b)) {
    if (season !== previous + 1 || new Set(group.map((file) => file.folder)).size !== 1 || group.some((file) => file.number === null)) break;
    const at = catalog[offset];
    if (!at || (offset > 0 && catalog[offset - 1]!.season !== at.season && at.season !== season)) break;
    const sorted = group.sort((a, b) => a.number! - b.number!);
    const first = sorted[0]!.number;
    if (first !== 1 && first !== offset + 1) break;
    for (const [i, file] of sorted.entries()) {
      const episode = catalog[offset];
      if (file.number !== first + i || file.number === sorted[i + 1]?.number || !episode || episode.season !== at.season || episode.number !== at.number + i) return assignments;
      if (file.season !== season && (file.season !== episode.season || file.number !== episode.number)) return assignments;
      assignments.set(file.path, [{ season: episode.season, number: episode.number }]);
      offset++;
    }
    previous = season;
  }
  return assignments;
}
