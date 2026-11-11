import { db } from '../../../../core/db.ts';
import { randomUUID } from 'node:crypto';
import type { SearchPlan } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import { upgradeQualities } from '../../../../library/grab/upgrades.ts';
import type { Finder } from '../../../../library/grab/finder.ts';
import { libraryFilter, libraryType, matchesType } from '../../../../library/tools/filters.ts';
import type { Title } from '../../../../library/library.ts';
import { isObject, MAX_KEYS, MAX_PLANS, plans, SAMPLE, startable, type Kind } from '../plans.ts';

export function librarySearchPreview(finder: Finder): RequestHandler {
  return (req, res) => {
    const body = isObject(req.body) ? req.body : {};
    const kind: Kind = body.kind === 'upgrades' ? 'upgrades' : 'search';
    // The Upgrade button of a title page sends the quality that the user chose.
    const upgrade = kind === 'upgrades' && body.keys !== undefined;
    const quality = body.quality;
    if (upgrade && !(typeof quality === 'string' && quality !== '')) return void res.status(400).json({ error: 'invalid_quality' });
    let titles: Title[];
    if (body.keys !== undefined) {
      if (!Array.isArray(body.keys) || body.keys.length > MAX_KEYS || !body.keys.every((key) => typeof key === 'string')) return void res.status(400).json({ error: 'invalid_selection' });
      titles = [...new Set<string>(body.keys)].flatMap((key) => db.data.titles[key] ?? []);
    } else {
      const filter = libraryFilter(body.filter);
      if ('error' in filter) return void res.status(400).json({ error: filter.error });
      const type = libraryType(body.type);
      titles = Object.values(db.data.titles).filter((title) => matchesType(title, type) && filter.test(title));
    }

    // The chosen quality must be one that the profile chain of a requested title defines above a file.
    if (upgrade && titles.length > 0 && !titles.some((title) => upgradeQualities(title).some((item) => item.id === quality))) return void res.status(409).json({ error: 'no_better_qualities' });
    const counted = titles
      .map((title) => ({ title, targets: kind === 'upgrades' ? finder.upgradeCount(title, quality as string) : startable(finder, title) }))
      .filter((item) => item.targets > 0)
      .sort((a, b) => a.title.meta.title.localeCompare(b.title.meta.title) || a.title.key.localeCompare(b.title.key));
    const targets = counted.reduce((sum, item) => sum + item.targets, 0);
    let planId: string | null = null;
    if (counted.length) {
      planId = randomUUID();
      plans.set(planId, { keys: counted.map((item) => item.title.key), targets, kind, quality: quality as string, jobId: null });
      while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);
    }
    const plan: SearchPlan = {
      planId,
      titles: counted.length,
      targets,
      sample: counted.slice(0, SAMPLE).map(({ title, targets }) => ({ key: title.key, mediaType: title.mediaType, title: title.meta.title, year: title.meta.year, targets })),
    };
    res.json(plan);
  };
}
