import type { AddMode, MediaType } from '@ladarr/shared/enums';
import type { Db } from '../core/db.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { deleteItemLog } from '../core/log.ts';
import { titleKey, type Override, type Title } from './library.ts';
import { refreshJob } from './metadata.ts';
import { scanJob } from './scan.ts';
import type { EpisodeMeta, TitleMeta, Tmdb } from '../metadata/tmdb.ts';

export type AddInput = {
  mediaType: MediaType;
  tmdbId: number;
  mode: AddMode;
  seriesType: 'standard' | 'anime';
  preset: string | null;
  rootId: string;
  folder?: string | null;
  seasonOverrides?: Record<string, Override>;
  // The episodes of a series that the caller already holds. They save the wait for the refresh job.
  episodes?: EpisodeMeta[];
  // The facts that the caller already holds. With them, the add waits for no request.
  meta?: TitleMeta;
  // The page has these facts from the search or the preview, so the row looks right before the refresh.
  summary?: { title: string; year: number | null; posterPath: string | null };
  // A movie that the source searched before its release. The import keeps the choice.
  manualRelease?: boolean;
  // The add returns before the TMDB facts arrive. A queue job fetches them, and the summary shows meanwhile.
  deferMetadata?: boolean;
};

export class AddError extends Error {
  code: 'already_in_library';
  key: string;
  constructor(code: AddError['code'], key: string) {
    super(code);
    this.code = code;
    this.key = key;
  }
}

// A title that comes back starts with an empty queue. The targets of the record that was removed before do not return.
function forgetTargets(db: Db, key: string) {
  const ids = new Set(Object.values(db.data.queue).filter((entry) => entry.titleKey === key).map((entry) => entry.id));
  if (ids.size === 0) return;
  for (const id of ids) {
    delete db.data.queue[id];
    deleteItemLog(id);
  }
  for (const job of Object.values(db.data.jobs)) {
    const entryIds = (job.payload as { entryIds?: string[] } | null)?.entryIds;
    if (job.state === 'waiting' && entryIds?.some((id) => ids.has(id))) delete db.data.jobs[job.id];
  }
}

// The facts that a title shows until the refresh job brings the TMDB ones. The key is the last fallback, so a
// caller that has no summary still gets a title that the queue and the page can show.
function placeholderMeta(input: AddInput): TitleMeta {
  const title = input.summary?.title ?? titleKey(input.mediaType, input.tmdbId);
  return {
    mediaType: input.mediaType,
    tmdbId: input.tmdbId,
    title,
    year: input.summary?.year ?? null,
    overview: '',
    posterPath: input.summary?.posterPath ?? null,
    originalLanguage: '',
    originalTitle: title,
    aliases: [],
    date: null,
    status: '',
    rating: null,
    votes: 0,
    backdropPath: null,
    runtime: null,
    imdbId: null,
    tvdbId: null,
    releaseDates: [],
    seasons: [],
  };
}

// The one way a title enters the library. The add form and the migration both use it.
// The caller saves the database after this returns.
export async function addTitle(
  { db, tmdb, enqueue }: { db: Db; tmdb: Tmdb; enqueue: (input: EnqueueInput) => Job },
  input: AddInput,
): Promise<{ title: Title; jobId: string | null }> {
  const key = titleKey(input.mediaType, input.tmdbId);
  if (db.data.titles[key]) throw new AddError('already_in_library', key);
  // The facts of an add from the page arrive in the queue job, so the add waits for no request. The other callers
  // keep the facts that they hold, or wait for TMDB as they did before.
  let fetched = input.meta;
  if (!fetched && !input.deferMetadata) {
    fetched = await tmdb.details(input.mediaType, input.tmdbId);
    // The request waited for TMDB, so another request may have added the title.
    if (db.data.titles[key]) throw new AddError('already_in_library', key);
  }

  const meta = fetched ?? placeholderMeta(input);
  forgetTargets(db, key);
  const now = Date.now();
  const episodes = input.episodes?.map((episode) => ({ ...episode, override: null, fileId: null }));
  const title: Title = {
    key,
    mediaType: input.mediaType,
    tmdbId: input.tmdbId,
    meta,
    metaLoadedAt: fetched ? now : null,
    refreshedAt: fetched ? now : 0,
    addedAt: now,
    paused: input.mode === 'paused',
    policy: input.mode === 'future' ? 'future' : 'all',
    futureFrom: now,
    seriesType: input.seriesType,
    preset: input.preset,
    rootId: input.rootId,
    folder: input.folder ?? null,
    manualRelease: input.manualRelease ?? false,
    seasonOverrides: input.seasonOverrides ?? {},
    episodesLoadedAt: episodes && input.mediaType === 'tv' ? now : null,
    episodes: episodes ?? [],
    fileId: null,
  };
  db.data.titles[key] = title;
  // A series needs its episodes, and a title that waits for its facts needs them too. One job does both.
  const job = (input.mediaType === 'tv' && !episodes) || !fetched ? enqueue(refreshJob(key)) : undefined;
  // A series is scanned after its episodes are known. A movie can be scanned now, when its facts are known.
  if (input.folder && input.mediaType === 'movie' && fetched) enqueue(scanJob(key));
  return { title, jobId: job?.id ?? null };
}
