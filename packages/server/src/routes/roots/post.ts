import { randomUUID } from 'node:crypto';
import type { MediaType } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import type { Db, Root } from '../../core/db.ts';
import { inside, refusal, validateNewRoot } from '../../library/roots.ts';

export function rootsCreate(db: Db, { configDir }: { configDir?: string } = {}): RequestHandler {
  return async (req, res) => {
    const { path, mediaType } = (req.body ?? {}) as { path?: unknown; mediaType?: MediaType };
    if (typeof path !== 'string' || !path || (mediaType !== 'movie' && mediaType !== 'tv')) {
      return void res.status(400).json({ error: 'invalid_root' });
    }
    const result = await validateNewRoot(db, path, configDir);
    if (refusal(result)) return void res.status(400).json(result);
    // The check awaited, so another request may have added an overlapping folder. Check again before the save.
    if (Object.values(db.data.roots).some((root) => inside(root.path, result.path) || inside(result.path, root.path))) {
      return void res.status(400).json({ error: 'root_overlaps_root' });
    }
    const root: Root = { id: randomUUID(), path: result.path, mediaType, dev: result.dev };
    db.data.roots[root.id] = root;
    // The first root of a media type becomes its default.
    const defaults = db.data.settings.defaultRoots;
    defaults[mediaType] ??= root.id;
    await db.write();
    res.status(201).json({ ...root, check: result.check });
  };
}
