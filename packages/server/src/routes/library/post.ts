import { get } from '../../core/db.ts';
import type { AddMode } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import { explainProfile } from '../../library/grab/quality.ts';
import { profilesFor, type Db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import type { EnqueueInput, Job } from '../../core/jobs.ts';
import { catalog, titleFields } from '../../core/log.ts';
import { AddError, addTitle } from '../../library/tools/add.ts';
import type { Tmdb } from '../../metadata/tmdb.ts';
import { changed, detail, isObject, seasonOverridesOf, summaryOf } from '../../helpers/library.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job };

export function libraryAdd({ tmdb, events, enqueue }: Deps): RequestHandler {
  const db = get();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const body = isObject(req.body) ? req.body : {};
    const { mediaType, tmdbId } = body;
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) {
      return void res.status(400).json({ error: 'invalid_title' });
    }
    const mode = (body.add ?? 'all') as AddMode;
    if (!['all', 'future', 'paused'].includes(mode) || (mediaType === 'movie' && mode === 'future')) {
      return void res.status(400).json({ error: 'invalid_add_mode' });
    }
    const seriesType = body.seriesType ?? 'standard';
    if ((seriesType !== 'standard' && seriesType !== 'anime') || (mediaType === 'movie' && seriesType !== 'standard')) {
      return void res.status(400).json({ error: 'invalid_series_type' });
    }
    const preset = body.preset ?? null;
    if (preset !== null && !(typeof preset === 'string' && Object.hasOwn(db.data.profiles, preset))) return void res.status(400).json({ error: 'invalid_preset' });
    const rootId = body.rootId ?? db.data.settings.defaultRoots[mediaType];
    if (typeof rootId !== 'string' || db.data.roots[rootId]?.mediaType !== mediaType) return void res.status(400).json({ error: 'root_required' });
    const seasonOverrides = seasonOverridesOf(body.seasonOverrides);
    if (seasonOverrides === null || (mediaType === 'movie' && Object.keys(seasonOverrides ?? {}).length > 0)) return void res.status(400).json({ error: 'invalid_season_overrides' });
    const summary = summaryOf(body.summary);
    if (summary === null) return void res.status(400).json({ error: 'invalid_summary' });

    let added;
    try {
      // The add returns before the TMDB facts arrive. The refresh job fetches them, and the queue shows the title meanwhile.
      added = await addTitle({ db, tmdb, enqueue }, { mediaType, tmdbId, mode, seriesType, preset, rootId, seasonOverrides, summary, deferMetadata: true });
    } catch (err) {
      if (err instanceof AddError) return void res.status(409).json({ error: err.code, key: err.key });
      throw err;
    }
    const profile = profilesFor(db.data, added.title)[0]!;
    const shown = explainProfile(profile);
    catalog.info('added', `Added to the library with profile ${shown.name} (${shown.qualities.join(', ')})`, titleFields(added.title), {
      year: added.title.meta.year,
      mode,
      seriesType,
      rootId,
      profile: shown,
    });
    // The first search runs when the episodes are known. A paused title is not searched, and neither is a series
    // with no monitored season yet: its episodes start the search when they air.
    const searchNow = mode !== 'future' || Object.keys(seasonOverrides ?? {}).length > 0;
    if (!added.title.paused && searchNow) enqueue({ type: 'queue.initial', payload: { key: added.title.key }, dedupeKey: `initial:${added.title.key}` });
    await changed(db, events, added.title.key);
    res.status(201).json({ title: detail(db, added.title), jobId: added.jobId });
  };
}
