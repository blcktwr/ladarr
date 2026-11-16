import { db } from '../core/db.ts';
import type { Db, EnqueueInput, Job, SourceDownload, SourceEpisode } from '../types.ts';

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
