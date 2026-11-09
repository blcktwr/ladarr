import type { Response } from 'express';
import { PlanError } from '../library/imports/plan.ts';

const STATUS: Record<string, number> = { folder_not_found: 404, root_required: 409, root_unavailable: 409, title_busy: 409, nothing_to_import: 409 };

export function fail(res: Response, error: unknown) {
  if (!(error instanceof PlanError)) throw error;
  res.status(STATUS[error.code] ?? 400).json({ error: error.code });
}
