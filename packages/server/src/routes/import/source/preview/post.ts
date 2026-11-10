import { get } from '../../../../core/db.ts';
import type { RequestHandler } from 'express';
import type { Tmdb } from '../../../../metadata/tmdb.ts';
import { prepare } from '../../../../library/imports/source.ts';
import { folderName } from '../../../../library/naming.ts';
import { fail } from '../../../../helpers/import-source.ts';

// Shows what an import would do. Nothing changes.
export function importSourcePreview({ tmdb, configDir }: { tmdb?: Tmdb; configDir?: string } = {}): RequestHandler {
  const db = get();
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const body = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, unknown>;
    const { mediaType, tmdbId } = body;
    if ((mediaType !== 'movie' && mediaType !== 'tv') || typeof tmdbId !== 'number' || !Number.isInteger(tmdbId) || tmdbId < 1) {
      return void res.status(400).json({ error: 'invalid_title' });
    }
    try {
      const { title, created, rootId, rootReal, health, plan } = await prepare(db, tmdb, configDir, { path: body.path, mediaType, tmdbId });
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
  };
}
