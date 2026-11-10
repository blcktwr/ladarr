import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import { enqueue } from '../core/jobs.ts';
import { catalog, titleFields } from '../core/log.ts';
import { mergeEpisodes } from '../library/library.ts';
import { scanJob } from '../library/scan.ts';
import { verifyJob } from '../library/verification.ts';
import type { EpisodeMeta, Tmdb } from '../metadata/tmdb.ts';
import type { Handler } from '../core/worker.ts';

export function metadataRefreshHandler({ db, tmdb, events }: { db: Db; tmdb: Tmdb; events: Events }): Handler {
  // The first search of a title waits for the episodes. It starts at once when they arrive, so its row does not wait
  // for the retry of the job.
  function resumeInitialSearch(key: string) {
    const dedupeKey = `initial:${key}`;
    if (Object.values(db.data.jobs).some((job) => job.dedupeKey === dedupeKey && job.state === 'waiting')) enqueue({ type: 'queue.initial', payload: { key }, dedupeKey });
  }

  async function refresh(key: string, signal: AbortSignal) {
    const title = db.data.titles[key];
    if (!title) return;

    // Every request comes first. If one fails, the saved data stays as it is, and the job tries again later.
    const meta = await tmdb.details(title.mediaType, title.tmdbId, 0);
    const fetched: EpisodeMeta[] = [];
    if (title.mediaType === 'tv') {
      for (const season of meta.seasons) {
        if (season.episodeCount === 0) continue;
        signal.throwIfAborted();
        fetched.push(...(await tmdb.season(title.tmdbId, season.seasonNumber, 0)));
      }
    }

    // No await from here, so the change lands in one step.
    const current = db.data.titles[key];
    if (!current) return;
    const firstMeta = current.metaLoadedAt === null;
    const firstLoad = current.mediaType === 'tv' && current.episodesLoadedAt === null;
    current.meta = meta;
    current.refreshedAt = Date.now();
    if (firstMeta) current.metaLoadedAt = current.refreshedAt;
    if (current.mediaType === 'tv') {
      current.episodes = mergeEpisodes(current.episodes, fetched);
      current.episodesLoadedAt = Date.now();
      const seasons = new Set(current.episodes.map((episode) => episode.season)).size;
      if (firstLoad) {
        catalog.info('episodes', `Loaded ${current.episodes.length} ${current.episodes.length === 1 ? 'episode' : 'episodes'} in ${seasons} ${seasons === 1 ? 'season' : 'seasons'}`, titleFields(current), { episodes: current.episodes.length, seasons });
      } else {
        catalog.info('refreshed', 'Refreshed the metadata from TMDB', titleFields(current), { episodes: current.episodes.length, seasons });
      }
    } else {
      catalog.info('refreshed', 'Refreshed the metadata from TMDB', titleFields(current));
    }
    // The files of a series are matched to episodes, so the scan waits for the episodes. A movie that entered the
    // queue first waits for its facts, because the scan matches its file by the name of the title.
    if (current.mediaType === 'tv' && current.folder) enqueue(scanJob(key));
    if (current.mediaType === 'movie' && firstMeta && current.folder) enqueue(scanJob(key));
    if (firstLoad || (current.mediaType === 'movie' && firstMeta)) resumeInitialSearch(key);
    // A verification that waited for the facts of the title starts now.
    if (db.data.verifications[key]?.pending) enqueue(verifyJob(key));
    events.publish('library.changed', { key });
  }

  return {
    concurrency: 2,
    run: (job, { signal }) => refresh((job.payload as { key: string }).key, signal),
  };
}
