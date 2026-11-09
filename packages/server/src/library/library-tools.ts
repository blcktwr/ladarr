import { Router } from 'express';
import type { Db } from '../core/db.ts';
import type { Events } from '../core/events.ts';
import type { EnqueueInput, Job } from '../core/jobs.ts';
import { libraryFilesRouter } from './library-files.ts';
import { libraryFoldersRouter } from './library-folders.ts';
import { libraryPlansRouter } from './library-plans.ts';
import type { Queue } from '../downloads/queue.ts';
import type { Tmdb } from '../metadata/tmdb.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; queue?: Queue; cancelJob?: (id: string) => void };

// The file details, the bulk actions, and the folders without a title. Mount it before the library router,
// because the names "folders" and "plans" would otherwise match the title key there.
export function libraryToolsRouter(db: Db, deps: Deps) {
  const router = Router();
  router.use(libraryFoldersRouter(db, deps), libraryPlansRouter(db, deps), libraryFilesRouter(db));
  return router;
}
