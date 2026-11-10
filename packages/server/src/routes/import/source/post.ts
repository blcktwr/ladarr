import { get } from '../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Events } from '../../../core/events.ts';
import type { EnqueueInput, Job } from '../../../core/jobs.ts';
import type { Tmdb } from '../../../metadata/tmdb.ts';
import type { ImportStatus } from '../../../library/imports/status.ts';
import { prepare } from '../../../library/imports/source.ts';
import { openJournal, PlanError, titleBusy } from '../../../library/imports/plan.ts';
import { AddError, addTitle } from '../../../library/tools/add.ts';
import { fail } from '../../../helpers/import-source.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; status: ImportStatus; configDir?: string };

// The plan is made again here. The server does not trust the preview that the browser holds.
export function importSourceStart({ tmdb, events, enqueue, status, configDir }: Deps): RequestHandler {
  const db = get();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const { mediaType, tmdbId } = body;
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) {
      return void res.status(400).json({ error: 'invalid_title' });
    }
    try {
      const prepared = await prepare(db, tmdb, configDir, { path: body.path, mediaType, tmdbId });
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
  };
}
