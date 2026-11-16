import { Router } from 'express';
import { db } from '../../core/db.ts';
import { libraryFilesRouter } from './files.ts';
import { libraryFoldersRouter } from './folders.ts';
import { libraryPlansRouter } from './plans.ts';
import type { ToolsDeps } from '../../types.ts';

// The file details, the bulk actions, and the folders without a title. Mount it before the library router,
// because the names "folders" and "plans" would otherwise match the title key there.
export function libraryToolsRouter(deps: ToolsDeps) {
  const router = Router();
  router.use(libraryFoldersRouter(deps), libraryPlansRouter(deps), libraryFilesRouter());
  return router;
}
