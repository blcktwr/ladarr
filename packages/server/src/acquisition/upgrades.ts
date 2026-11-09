import { basename } from 'node:path';
import { profilesFor, type Db, type MediaFile } from '../core/db.ts';
import { isMonitored, type Title } from '../library/library.ts';
import { qualityResolution, type ReleaseSource } from './quality.ts';
import { parseRelease } from './release.ts';

// The release that gave a file, or else the words in its name, tell the source and the resolution of the file.
export function qualityOfFile(file: MediaFile): { source: ReleaseSource; resolution: number | null } {
  const parsed = file.source ? null : parseRelease(basename(file.path));
  return { source: file.source ?? parsed!.source, resolution: file.source ? (file.resolution ?? null) : parsed!.resolution };
}

// A file of a title that an upgrade can replace. The file holds one episode and its resolution is known.
type UpgradeFile = { title: Title; season: number | null; number: number | null; file: MediaFile; resolution: number };

// The files of a title, with the episode of each one. A paused title has none.
function upgradeFiles(db: Db, title: Title): UpgradeFile[] {
  if (title.paused) return [];
  const files: UpgradeFile[] = [];
  const add = (fileId: string | null, season: number | null, number: number | null) => {
    const file = fileId ? db.data.files[fileId] : undefined;
    if (!file || file.missing) return;
    // A file for several episodes is the file of the other episodes too, so one upgrade must not replace it.
    if (file.episodes.length > 1) return;
    const { resolution } = qualityOfFile(file);
    if (resolution === null) return;
    files.push({ title, season, number, file, resolution });
  };
  if (title.mediaType === 'movie') add(title.fileId, null, null);
  else for (const episode of title.episodes) if (isMonitored(title, episode, db.data.settings)) add(episode.fileId, episode.season, episode.number);
  return files;
}

// The resolutions that the profile chain of the title defines, the lowest first.
const definedResolutions = (db: Db, title: Title) =>
  [...new Set(profilesFor(db.data, title).flatMap((profile) => profile.items.flat()).map(qualityResolution))]
    .filter((resolution): resolution is number => resolution !== null)
    .sort((a, b) => a - b);

// The resolutions that the Upgrade button of a title page offers: the ones that the chain defines above a file.
export function upgradeResolutions(db: Db, title: Title): number[] {
  const files = upgradeFiles(db, title);
  return definedResolutions(db, title).filter((resolution) => files.some((file) => file.resolution < resolution));
}

// The files that a search of one resolution covers: the files below it, when the chain defines it.
export function manualUpgradeTargets(db: Db, title: Title, resolution: number): UpgradeFile[] {
  if (!definedResolutions(db, title).includes(resolution)) return [];
  return upgradeFiles(db, title).filter((file) => file.resolution < resolution);
}
