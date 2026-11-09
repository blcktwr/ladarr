import type { Response } from 'express';
import { PlanError } from '../library/imports/plan.ts';

const STATUS: Record<string, number> = { title_not_found: 404, folder_not_found: 404, root_unavailable: 409, title_busy: 409, nothing_to_import: 409 };

export function fail(res: Response, error: unknown) {
  if (!(error instanceof PlanError)) throw error;
  res.status(STATUS[error.code] ?? 400).json({ error: error.code });
}

export const input = (body: unknown, configDir?: string) => {
  const { titleKey, path, replace } = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>;
  return { titleKey: String(titleKey ?? ''), path, replace: replace === true, configDir };
};
