import { type Db, db } from '../core/db.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { SourceDownload, SourceEpisode } from '../migration/migration-source.ts';

// What the verification of one title must check: the hashes that the source recorded, and the episodes that the
// source monitors. The state stays in the database, so a restart, a client outage, or a second import does not lose it.
export type VerificationState = {
  key: string;
  downloads: SourceDownload[];
  episodes: SourceEpisode[];
  // True until a run of the verification ends with no outage. A periodic job starts the pending ones again.
  pending: boolean;
  updatedAt: number;
};

export const verifyJob = (key: string) => ({ type: 'library.verify', payload: { key }, dedupeKey: `verify:${key}` });

const hashOf = (download: SourceDownload) => download.hash;

function mergeDownloads(current: SourceDownload[], next: SourceDownload[]): SourceDownload[] {
  const byHash = new Map(current.map((download) => [hashOf(download), download]));
  for (const download of next) {
    const known = byHash.get(download.hash);
    if (!known) {
      byHash.set(download.hash, download);
      continue;
    }
    // A pack can arrive in more than one row of the same import. The newest event wins for the whole hash.
    const episodes = [...known.episodes];
    for (const episode of download.episodes) if (!episodes.some((item) => item.season === episode.season && item.number === episode.number)) episodes.push(episode);
    byHash.set(download.hash, download.id >= known.id ? { ...download, episodes } : { ...known, episodes });
  }
  return [...byHash.values()];
}

function mergeEpisodes(current: SourceEpisode[], next: SourceEpisode[]): SourceEpisode[] {
  const byNumber = new Map(current.map((episode) => [`${episode.season}x${episode.number}`, episode]));
  for (const episode of next) byNumber.set(`${episode.season}x${episode.number}`, episode);
  return [...byNumber.values()];
}

// Saves the work, and starts the job. `enqueue` does not merge a payload, so the job reads the saved state.
export function requestVerification(
  enqueue: (input: EnqueueInput) => Job,
  key: string,
  { downloads = [], episodes = [] }: { downloads?: SourceDownload[]; episodes?: SourceEpisode[] },
): Job | undefined {
  if (!db.data.titles[key]) return;
  const current = db.data.verifications[key];
  db.data.verifications[key] = {
    key,
    downloads: mergeDownloads(current?.downloads ?? [], downloads),
    episodes: mergeEpisodes(current?.episodes ?? [], episodes),
    pending: true,
    updatedAt: Date.now(),
  };
  return enqueue(verifyJob(key));
}

// The first run of a title after an add. The title exists, so the state is new.
export const verificationOf = (key: string) => db.data.verifications[key];
