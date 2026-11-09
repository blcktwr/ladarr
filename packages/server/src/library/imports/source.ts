import type { MediaType, RootProblem } from '@ladarr/shared/enums';
import { basename, extname } from 'node:path';
import type { Db } from '../../core/db.ts';
import type { EpisodeMeta, TitleMeta, Tmdb } from '../../metadata/tmdb.ts';
import type { Found } from './importer.ts';
import { PlanError, readableRoot } from './plan.ts';
import { mergeEpisodes, titleKey, type Title } from '../library.ts';
import { guessTitle } from '../tools/folders.ts';
import { planFiles, readFolder } from './manual.ts';
import { checkRoot } from '../roots.ts';

// The import of a folder anywhere on the disk, normally a download folder. The folder stays where it is: its files are
// hard linked into the library, and a file that can not be linked is blocked instead of copied.

const BAD_ROOT: RootProblem[] = ['not_found', 'not_directory', 'not_readable', 'not_writable', 'mount_changed'];
export const MAX_FILES = 5_000;

// The parts of a release name that say nothing about the title.
const TAGS = new Set(['2160p', '1080p', '720p', '4k', 'web-dl', 'webrip', 'bluray', 'brrip', 'hdtv', 'dvdrip', 'x264', 'x265', 'h264', 'h265', 'hevc', 'aac', 'ac3', 'dts']);
const MARKER = /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})/i;

// The title and the year that the name of a file suggests. The season marker and the release parts go away.
export function titleFromFile(rel: string): { title: string; year: number | null } | undefined {
  const name = basename(rel, extname(rel));
  const marker = MARKER.exec(name);
  const words = (marker ? name.slice(0, marker.index) : name).split(/[._ ]+/).filter((word) => word && !TAGS.has(word.toLowerCase()));
  const text = words.join(' ');
  return text ? guessTitle(text) : undefined;
}

export const biggestFirst = (videos: Found[]) => [...videos].sort((a, b) => b.sizeBytes - a.sizeBytes || a.rel.localeCompare(b.rel));

// The episodes of a series that TMDB lists, in the order of the seasons.
async function episodesOf(tmdb: Tmdb, tmdbId: number, meta: TitleMeta): Promise<EpisodeMeta[]> {
  const episodes: EpisodeMeta[] = [];
  for (const season of meta.seasons) {
    if (season.episodeCount === 0) continue;
    episodes.push(...(await tmdb.season(tmdbId, season.seasonNumber)));
  }
  return episodes;
}

// A title that is not in the catalog yet. The preview plans against it, and the start adds it. It is never saved here.
async function draftTitle(tmdb: Tmdb, mediaType: MediaType, tmdbId: number, rootId: string): Promise<{ title: Title; episodes: EpisodeMeta[] }> {
  const meta = await tmdb.details(mediaType, tmdbId);
  const episodes = mediaType === 'tv' ? await episodesOf(tmdb, tmdbId, meta) : [];
  const now = Date.now();
  const title: Title = {
    key: titleKey(mediaType, tmdbId),
    mediaType,
    tmdbId,
    meta,
    refreshedAt: now,
    addedAt: now,
    paused: false,
    policy: 'all',
    futureFrom: now,
    seriesType: 'standard',
    preset: null,
    rootId,
    folder: null,
    manualRelease: false,
    seasonOverrides: {},
    episodesLoadedAt: mediaType === 'tv' ? now : null,
    episodes: episodes.map((episode) => ({ ...episode, override: null, fileId: null })),
    fileId: null,
  };
  return { title, episodes };
}

// A series that is in the catalog without its episodes takes them for the plan. The copy keeps the stored title as it is.
async function withEpisodes(tmdb: Tmdb, title: Title): Promise<Title> {
  if (title.mediaType !== 'tv' || title.episodesLoadedAt !== null) return title;
  const meta = await tmdb.details(title.mediaType, title.tmdbId);
  return { ...title, episodes: mergeEpisodes(title.episodes, await episodesOf(tmdb, title.tmdbId, meta)) };
}

// Reads the folder and the title, and plans the files. It changes nothing.
export async function prepare(db: Db, tmdb: Tmdb | undefined, configDir: string | undefined, input: { path: unknown; mediaType: MediaType; tmdbId: number }) {
  const { real, videos } = await readFolder(db, { path: input.path, configDir });

    const key = titleKey(input.mediaType, input.tmdbId);
    const existing = db.data.titles[key];
    const rootId = existing ? existing.rootId : db.data.settings.defaultRoots[input.mediaType];
    const root = rootId ? db.data.roots[rootId] : undefined;
    if (!rootId || !root || root.mediaType !== input.mediaType) throw new PlanError('root_required');
    const rootReal = await readableRoot(root);
    const health = await checkRoot(root.path, root.dev);
    if (health.problems.some((problem) => BAD_ROOT.includes(problem))) throw new PlanError('root_unavailable');

    const draft = existing ? null : await draftTitle(tmdb!, input.mediaType, input.tmdbId, rootId);
    const title = draft?.title ?? (await withEpisodes(tmdb!, existing!));
    const plan = await planFiles(db, { title, rootReal, real, videos, replace: false, linkOnly: true });
    return { title, created: !existing, rootId, rootReal, health, plan, episodes: draft?.episodes, fetched: existing && title !== existing ? title.episodes : undefined };
  }

