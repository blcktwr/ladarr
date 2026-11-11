import { Router } from 'express';
import { db } from '../../core/db.ts';
import type { Events } from '../../core/events.ts';
import type { EnqueueInput, Job } from '../../core/jobs.ts';
import { libraryFilesRouter } from './files.ts';
import { libraryFoldersRouter } from './folders.ts';
import { libraryPlansRouter } from './plans.ts';
import type { Queue } from '../downloads/queue.ts';
import type { Clients } from '../downloads/client-api.ts';
import type { Tmdb } from '../../metadata/tmdb.ts';

type Deps = { tmdb?: Tmdb; events: Events; enqueue: (input: EnqueueInput) => Job; queue?: Queue; cancelJob?: (id: string) => void; clients?: Clients };

// The file details, the bulk actions, and the folders without a title. Mount it before the library router,
// because the names "folders" and "plans" would otherwise match the title key there.
export function libraryToolsRouter(deps: Deps) {
  const router = Router();
  router.use(libraryFoldersRouter(deps), libraryPlansRouter(deps), libraryFilesRouter());
  return router;
}
