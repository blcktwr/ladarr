import { randomUUID } from 'node:crypto';
import type { SearchPlan } from '@ladarr/shared/types';
import { Router } from 'express';
import { libraryFilter, libraryType, matchesType } from '../library/library-filters.ts';
import type { Db } from '../core/db.ts';
import type { Finder } from '../acquisition/finder.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import type { Title } from '../library/library.ts';
import { upgradeResolutions } from '../acquisition/upgrades.ts';
import { isActive } from '../downloads/queue.ts';

export const BULK_SEARCH_JOB = 'library.search';

const MAX_KEYS = 5_000;
const MAX_PLANS = 20;
const SAMPLE = 10;

// A plan of the kind `upgrades` comes from the Upgrade button of a title page. It searches the files below a resolution
// for a release of exactly that resolution. Other plans look for the missing files.
type Kind = 'search' | 'upgrades';
export type BulkSearchPayload = { planId: string; keys: string[]; offset: number; kind?: Kind; resolution?: number };
type Deps = { db: Db; finder: Finder; enqueue: (input: EnqueueInput) => Job };

const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

// The targets that a search would start now: wanted, and not in the journey already.
// A target that waits for a release starts again, like in the finder.
function startable(db: Db, finder: Finder, title: Title) {
  const free = (id: string) => {
    const entry = db.data.queue[id];
    return !entry || entry.attempt === 0 || !isActive(entry) || entry.branch === 'waiting';
  };
  if (title.mediaType === 'movie') return finder.wantedMovie(title) && free(title.key) ? 1 : 0;
  return title.episodes.filter((episode) => finder.wantedEpisode(title, episode) && free(`${title.key}:${episode.season}x${episode.number}`)).length;
}

// shortcut: plans stay in memory, so a restart drops them. The user starts the preview again.
export function bulkSearchRouter({ db, finder, enqueue }: Deps) {
  const router = Router();
  const plans = new Map<string, { keys: string[]; targets: number; kind: Kind; resolution: number; jobId: string | null }>();

  // The selection is a list of title keys, or a library filter with a media type.
  router.post('/preview', (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const kind: Kind = body.kind === 'upgrades' ? 'upgrades' : 'search';
    // The Upgrade button of a title page sends the resolution that the user chose.
    const upgrade = kind === 'upgrades' && body.keys !== undefined;
    const resolution = body.resolution;
    if (upgrade && !(typeof resolution === 'number' && Number.isInteger(resolution))) return void res.status(400).json({ error: 'invalid_resolution' });
    let titles: Title[];
    if (body.keys !== undefined) {
      if (!Array.isArray(body.keys) || body.keys.length > MAX_KEYS || !body.keys.every((key) => typeof key === 'string')) return void res.status(400).json({ error: 'invalid_selection' });
      titles = [...new Set<string>(body.keys)].flatMap((key) => db.data.titles[key] ?? []);
    } else {
      const filter = libraryFilter(db, body.filter);
      if ('error' in filter) return void res.status(400).json({ error: filter.error });
      const type = libraryType(body.type);
      titles = Object.values(db.data.titles).filter((title) => matchesType(title, type) && filter.test(title));
    }

    // The chosen resolution must be one that the profile chain of a requested title defines above a file.
    if (upgrade && titles.length > 0 && !titles.some((title) => upgradeResolutions(db, title).includes(resolution as number))) return void res.status(409).json({ error: 'no_better_qualities' });
    const counted = titles
      .map((title) => ({ title, targets: kind === 'upgrades' ? finder.upgradeCount(title, resolution as number) : startable(db, finder, title) }))
      .filter((item) => item.targets > 0)
      .sort((a, b) => a.title.meta.title.localeCompare(b.title.meta.title) || a.title.key.localeCompare(b.title.key));
    const targets = counted.reduce((sum, item) => sum + item.targets, 0);
    let planId: string | null = null;
    if (counted.length) {
      planId = randomUUID();
      plans.set(planId, { keys: counted.map((item) => item.title.key), targets, kind, resolution: resolution as number, jobId: null });
      while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);
    }
    const plan: SearchPlan = {
      planId,
      titles: counted.length,
      targets,
      sample: counted.slice(0, SAMPLE).map(({ title, targets }) => ({ key: title.key, mediaType: title.mediaType, title: title.meta.title, year: title.meta.year, targets })),
    };
    res.json(plan);
  });

  // The job runs the plan in batches. A second request for the same plan returns the same job.
  router.post('/', (req, res) => {
    const planId = isObject(req.body) && typeof req.body.planId === 'string' ? req.body.planId : '';
    const plan = plans.get(planId);
    if (!plan) return void res.status(404).json({ error: 'plan_not_found' });
    plan.jobId ??= enqueue({ type: BULK_SEARCH_JOB, payload: { planId, keys: plan.keys, offset: 0, ...(plan.kind === 'upgrades' ? { kind: plan.kind, resolution: plan.resolution } : {}) } satisfies BulkSearchPayload, dedupeKey: `${BULK_SEARCH_JOB}:${planId}:0` }).id;
    res.status(202).json({ jobId: plan.jobId, titles: plan.keys.length, targets: plan.targets });
  });

  return router;
}

