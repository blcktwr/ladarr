import { basename } from 'node:path';
import type { UpgradeQuality } from '@ladarr/shared/types';
import { type MediaFile, db, profilesFor } from '../../core/db.ts';
import { isMonitored, type Title } from '../library.ts';
import { chainFileRank, QUALITIES, RANK_STRIDE, type Profile, type ReleaseSource } from './quality.ts';
import { parseRelease } from './release.ts';

// The release that gave a file, or else the words in its name, tell the source and the resolution of the file.
export function qualityOfFile(file: MediaFile): { source: ReleaseSource; resolution: number | null } {
  const parsed = file.source ? null : parseRelease(basename(file.path));
  return { source: file.source ?? parsed!.source, resolution: file.source ? (file.resolution ?? null) : parsed!.resolution };
}

// A file of a title that an upgrade can replace. The file holds one episode and its quality is known.
type UpgradeFile = { title: Title; season: number | null; number: number | null; file: MediaFile; source: ReleaseSource; resolution: number };

// The files of a title, with the episode of each one. A paused title has none.
function upgradeFiles(title: Title): UpgradeFile[] {
  if (title.paused) return [];
  const files: UpgradeFile[] = [];
  const add = (fileId: string | null, season: number | null, number: number | null) => {
    const file = fileId ? db.data.files[fileId] : undefined;
    if (!file || file.missing) return;
    // A file for several episodes is the file of the other episodes too, so one upgrade must not replace it.
    if (file.episodes.length > 1) return;
    const { source, resolution } = qualityOfFile(file);
    // A file with no source or no resolution has no quality to compare, so an upgrade cannot choose it.
    if (source === 'unknown' || resolution === null) return;
    files.push({ title, season, number, file, source, resolution });
  };
  if (title.mediaType === 'movie') add(title.fileId, null, null);
  else for (const episode of title.episodes) if (isMonitored(title, episode)) add(episode.fileId, episode.season, episode.number);
  return files;
}

// The qualities that the chain defines, the best first. A quality that more than one profile defines keeps the rank of
// the first one.
type ChainQuality = UpgradeQuality & { rank: number; resolution: number | null };

function chainQualities(profiles: Profile[]): ChainQuality[] {
  const qualities = new Map<string, ChainQuality>();
  profiles.forEach((profile, profileIndex) => {
    profile.items.forEach((group, groupIndex) => {
      for (const id of group) {
        if (qualities.has(id)) continue;
        const quality = QUALITIES.find((item) => item.id === id);
        qualities.set(id, { id, label: quality?.label ?? id, resolution: quality?.resolution ?? null, rank: profileIndex * RANK_STRIDE + groupIndex });
      }
    });
  });
  return [...qualities.values()];
}

// The rank of a file in the chain. A file whose quality no profile takes is worse than the whole chain.
const rankOf = (profiles: Profile[], file: UpgradeFile) => chainFileRank(profiles, file.source, file.resolution)?.rank ?? -1;

// True when the quality is above the file: a higher resolution, or the same resolution with a better rank in the chain.
function isAbove(file: UpgradeFile, rank: number, quality: ChainQuality) {
  if (quality.resolution !== null && quality.resolution !== file.resolution) return quality.resolution > file.resolution;
  return rank > quality.rank;
}

const rankedFiles = (profiles: Profile[], title: Title) => upgradeFiles(title).map((file) => ({ file, rank: rankOf(profiles, file) }));

// The qualities that the Upgrade button of a title page offers: the ones that the chain defines above a file.
export function upgradeQualities(title: Title): UpgradeQuality[] {
  const profiles = profilesFor(db.data, title);
  const files = rankedFiles(profiles, title);
  return chainQualities(profiles)
    .filter((quality) => files.some(({ file, rank }) => isAbove(file, rank, quality)))
    .map(({ id, label }) => ({ id, label }));
}

// The files that a search of one quality covers: the files below it, when the chain defines it.
export function manualUpgradeTargets(title: Title, quality: string): UpgradeFile[] {
  const profiles = profilesFor(db.data, title);
  const chosen = chainQualities(profiles).find((item) => item.id === quality);
  if (!chosen) return [];
  return rankedFiles(profiles, title)
    .filter(({ file, rank }) => isAbove(file, rank, chosen))
    .map(({ file }) => file);
}
