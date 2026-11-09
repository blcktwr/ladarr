import type { MediaType, RootProblem } from '@ladarr/shared/enums';
import type { SourceFolder } from '@ladarr/shared/types';
import { basename, extname } from 'node:path';
import { Router } from 'express';
import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { EpisodeMeta, TitleMeta, Tmdb } from '../metadata/tmdb.ts';
import type { ImportStatus } from './import-status.ts';
import type { Found } from './importer.ts';
import { openJournal, PlanError, readableRoot, titleBusy } from './import-plan.ts';
import { AddError, addTitle } from './library-add.ts';
import { mergeEpisodes, titleKey, type Title } from './library.ts';
import { guessTitle } from './library-folders.ts';
import { planFiles, readFolder } from './manual-import.ts';
import { folderName } from './naming.ts';
import { parseEpisodes } from './parse.ts';
import { checkRoot } from './roots.ts';

// The import of a folder anywhere on the disk, normally a download folder. The folder stays where it is: its files are
// hard linked into the library, and a file that can not be linked is blocked instead of copied.

const STATUS: Record<string, number> = { folder_not_found: 404, root_required: 409, root_unavailable: 409, title_busy: 409, nothing_to_import: 409 };
const BAD_ROOT: RootProblem[] = ['not_found', 'not_directory', 'not_readable', 'not_writable', 'mount_changed'];
const MAX_FILES = 5_000;

// The parts of a release name that say nothing about the title.
const TAGS = new Set(['2160p', '1080p', '720p', '4k', 'web-dl', 'webrip', 'bluray', 'brrip', 'hdtv', 'dvdrip', 'x264', 'x265', 'h264', 'h265', 'hevc', 'aac', 'ac3', 'dts']);
const MARKER = /(?:^|[^a-z0-9])(?:s\d{1,2}[ ._-]?e\d{1,3}|\d{1,2}x\d{2,3})/i;

// The title and the year that the name of a file suggests. The season marker and the release parts go away.
function titleFromFile(rel: string): { title: string; year: number | null } | undefined {
  const name = basename(rel, extname(rel));
  const marker = MARKER.exec(name);
  const words = (marker ? name.slice(0, marker.index) : name).split(/[._ ]+/).filter((word) => word && !TAGS.has(word.toLowerCase()));
  const text = words.join(' ');
  return text ? guessTitle(text) : undefined;
}

const biggestFirst = (videos: Found[]) => [...videos].sort((a, b) => b.sizeBytes - a.sizeBytes || a.rel.localeCompare(b.rel));

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

type Deps = { db: Db; tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; status: ImportStatus; configDir?: string };

export function importSourceRouter({ db, tmdb, events, enqueue, status, configDir }: Deps) {
  const router = Router();
  const fail = (res: import('express').Response, error: unknown) => {
    if (!(error instanceof PlanError)) throw error;
    res.status(STATUS[error.code] ?? 400).json({ error: error.code });
  };

  // Reads the folder and the title, and plans the files. It changes nothing.
  async function prepare(input: { path: unknown; mediaType: MediaType; tmdbId: number }) {
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

  // The folder, the title that its name suggests, and the TMDB results of that name.
  router.post('/detect', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    try {
      const { path } = req.body ?? {};
      const { real, videos } = await readFolder(db, { path, configDir });
      if (!videos.length) throw new PlanError('nothing_to_import');
      const mediaType: MediaType = videos.some((file) => parseEpisodes(basename(file.rel))) ? 'tv' : 'movie';

      // The folder name first. The name of its biggest file comes second, because a download folder often has the
      // name of the download ("inbox") and not the name of the title.
      let guess = guessTitle(basename(real));
      let results = await tmdb.search(guess.title);
      if (!results.length) {
        const file = titleFromFile(biggestFirst(videos)[0]!.rel);
        const found = file ? await tmdb.search(file.title) : [];
        if (file && found.length) {
          guess = file;
          results = found;
        }
      }
      const folder: SourceFolder = {
        path: real,
        mediaType,
        guess,
        videoFiles: videos.length,
        sizeBytes: videos.reduce((sum, file) => sum + file.sizeBytes, 0),
        truncated: videos.length >= MAX_FILES,
        results: [...results.filter((result) => result.mediaType === mediaType), ...results.filter((result) => result.mediaType !== mediaType)],
      };
      res.json({ folder });
    } catch (error) {
      fail(res, error);
    }
  });

  // Shows what an import would do. Nothing changes.
  router.post('/preview', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const { mediaType, tmdbId } = body;
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) {
      return void res.status(400).json({ error: 'invalid_title' });
    }
    try {
      const { title, created, rootId, rootReal, health, plan } = await prepare({ path: body.path, mediaType, tmdbId });
      const { steps: _steps, ...view } = plan;
      res.json({
        preview: {
          titleKey: title.key,
          created,
          rootId,
          rootPath: rootReal,
          folder: title.folder ?? folderName(title),
          rootProblems: health.problems,
          freeBytes: health.freeBytes,
          plan: view,
        },
      });
    } catch (error) {
      fail(res, error);
    }
  });

  // The plan is made again here. The server does not trust the preview that the browser holds.
  router.post('/', async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const { mediaType, tmdbId } = body;
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) {
      return void res.status(400).json({ error: 'invalid_title' });
    }
    try {
      const prepared = await prepare({ path: body.path, mediaType, tmdbId });
      if (!prepared.plan.steps.length) throw new PlanError('nothing_to_import');
      if (titleBusy(db, prepared.title.key)) throw new PlanError('title_busy');
      if (prepared.created) {
        await addTitle({ db, tmdb, enqueue }, { mediaType, tmdbId, mode: 'all', seriesType: 'standard', preset: null, rootId: prepared.rootId, episodes: prepared.episodes });
      } else if (prepared.fetched) {
        // The title had no episodes yet. The plan read them from TMDB, so the stored title takes them before the import.
        const stored = db.data.titles[prepared.title.key];
        if (stored) {
          stored.episodes = prepared.fetched;
          stored.episodesLoadedAt = Date.now();
        }
      }
      const journal = await openJournal({ db, enqueue, status }, { kind: 'import', titleKey: prepared.title.key, sourceBase: prepared.plan.path, steps: prepared.plan.steps, linkOnly: true, searchOnFinish: true });
      // The title is in the catalog now, before its files are in.
      events.publish('library.changed', { key: prepared.title.key });
      res.status(202).json({ titleKey: prepared.title.key, created: prepared.created, id: journal.id, total: prepared.plan.steps.length });
    } catch (error) {
      if (error instanceof AddError) return void res.status(409).json({ error: error.code, key: error.key });
      fail(res, error);
    }
  });

  return router;
}
