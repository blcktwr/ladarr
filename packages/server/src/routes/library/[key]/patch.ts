import { db } from '../../../core/db.ts';
import { withTitleLock } from '../../../core/title-lock.ts';
import type { RequestHandler } from 'express';
import { requestVerification } from '../../../library/verification.ts';
import { assignSeasons, normalizeNumbering, validateNumbering } from '@ladarr/shared/numbering';
import { changed, detail, isObject } from '../../../helpers/library.ts';
import type { PatchDeps, Title } from '../../../types.ts';

const hasFiles = (title: Title) => Boolean(title.fileId) || title.episodes.some((episode) => episode.fileId);

export function libraryTitleUpdate({ events, enqueue, finder }: PatchDeps): RequestHandler<{ key: string }> {
  return async (req, res) => {
    // The save of a map and a refresh of the title can change the same record. One step at a time for each title.
    await withTitleLock((res.locals.title as Title).key, async () => {
      const title = db.data.titles[(res.locals.title as Title).key];
      if (!title) return void res.status(404).json({ error: 'not_found' });
      const body = req.body;
      if (!isObject(body)) return void res.status(400).json({ error: 'invalid_title_change' });
      const series = title.mediaType === 'tv';
      const next: Partial<Title> = {};
      let search: Set<string> | undefined;
      for (const [field, value] of Object.entries(body)) {
        if (field === 'paused' && typeof value === 'boolean') next.paused = value;
        else if (field === 'policy' && series && (value === 'all' || value === 'future')) {
          next.policy = value;
          // Future episodes counts from the moment the user chooses it.
          if (value === 'future' && title.policy !== 'future') next.futureFrom = Date.now();
        } else if (field === 'seriesType' && series && (value === 'standard' || value === 'anime')) next.seriesType = value;
        else if (field === 'preset' && (value === null || (typeof value === 'string' && Object.hasOwn(db.data.profiles, value)))) next.preset = value;
        else if (field === 'manualRelease' && !series && typeof value === 'boolean') next.manualRelease = value;
        else if (field === 'numbering' && series) {
          const check = validateNumbering(value);
          if (!check.ok) return void res.status(400).json({ error: check.error, ...(check.index === undefined ? {} : { index: check.index }), ...(check.field ? { field: check.field } : {}) });
          // A range names episodes that the catalog has. A number that TMDB dropped is not a target.
          for (const [index, range] of check.numbering.ranges.entries()) {
            for (let number = range.from; number <= range.to; number++) {
              if (!title.episodes.some((episode) => episode.season === range.season && episode.number === number)) {
                return void res.status(400).json({ error: 'invalid_numbering', index, field: 'from' });
              }
            }
          }
          const current = normalizeNumbering(title.numbering);
          if (check.numbering.revision !== current.revision) return void res.status(409).json({ error: 'numbering_changed' });
          // The same contents do not make a new revision.
          next.numbering = JSON.stringify(current.ranges) === JSON.stringify(check.numbering.ranges) ? current : { revision: current.revision + 1, ranges: check.numbering.ranges };
        } else if (field === 'episodeSeasons' && series && isObject(value) && Object.keys(body).length === 1) {
          const current = normalizeNumbering(title.numbering);
          if (value.revision !== current.revision) return void res.status(409).json({ error: 'numbering_changed' });
          const result = assignSeasons(current, title.episodes, value.edits);
          if (!result) return void res.status(400).json({ error: 'invalid_numbering' });
          if (JSON.stringify(current.ranges) !== JSON.stringify(result.numbering.ranges)) {
            next.numbering = { revision: current.revision + 1, ranges: result.numbering.ranges };
            search = new Set([...result.search].map((id) => `${title.key}:${id}`));
            if (search.size && !finder) return void res.status(503).json({ error: 'search_unavailable' });
          }
        } else if (field === 'rootId' && typeof value === 'string' && db.data.roots[value]?.mediaType === title.mediaType) {
          // Moving files between roots is a different action with a preview.
          if (value !== title.rootId && hasFiles(title)) return void res.status(409).json({ error: 'files_exist' });
          next.rootId = value;
        } else return void res.status(400).json({ error: 'invalid_title_change', field });
      }
      const wasPaused = title.paused;
      Object.assign(title, next);
      if (search?.size) finder?.requestSearch(title.key, { fresh: true, manual: true, remapped: true, only: search });
      // A resume checks the folder, the client, and the queue, and starts the search for the old missing targets. The
      // search of a title that the user paused has never run for them.
      if (wasPaused && !title.paused) requestVerification(enqueue, title.key, {});
      await changed(events, title.key);
      res.json({ title: detail(title) });
    });
  };
}
