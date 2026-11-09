import type { Response } from 'express';
import type { Db } from '../core/db.ts';
import type { NamingTemplates } from '../library/naming.ts';
import { templateProblem } from '../library/naming.ts';
import { PlanError } from '../library/imports/plan.ts';

const STATUS: Record<string, number> = { title_not_found: 404, root_unavailable: 409, title_busy: 409, nothing_to_rename: 409 };

export const isObject = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

export function fail(res: Response, error: unknown) {
  if (!(error instanceof PlanError)) throw error;
  res.status(STATUS[error.code] ?? 400).json({ error: error.code });
}

// The templates of the request, or the saved ones. A template that is not valid never reaches the plan.
export function templatesOf(db: Db, body: Record<string, unknown>): NamingTemplates | { invalid: string } {
  if (body.movie === undefined && body.episode === undefined) return db.data.settings.naming;
  const next = { movie: body.movie, episode: body.episode };
  for (const kind of ['movie', 'episode'] as const) if (templateProblem(kind, next[kind])) return { invalid: kind };
  return next as NamingTemplates;
}
