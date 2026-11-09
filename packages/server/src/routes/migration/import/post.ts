import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import type { EnqueueInput, Job } from '../../../core/jobs.ts';
import { applyExisting } from '../../../migration/migration.ts';
import { requestVerification } from '../../../library/verification.ts';
import { plans, progress } from '../../../helpers/migration.ts';

// Writes the ledger, and a job adds the titles. A restart keeps the rest of the work.
export function migrationImport(db: Db, enqueue: (input: EnqueueInput) => Job): RequestHandler {
  return (req, res) => {
    const plan = typeof req.body?.planId === 'string' ? plans.get(req.body.planId) : undefined;
    if (!plan) return void res.status(404).json({ error: 'plan_not_found' });
    const selected = Array.isArray(req.body.select) ? new Set(req.body.select.filter((key: unknown) => typeof key === 'string')) : undefined;

    let queued = 0;
    let verified = 0;
    for (const row of plan.rows) {
      if (selected && !selected.has(row.ledgerKey)) continue;
      const request = plan.requests.get(row.ledgerKey);
      if (request) {
        if (db.data.ledger[row.ledgerKey]?.status === 'pending') continue;
        if (!request.rootId) {
          db.data.ledger[row.ledgerKey] = { status: 'failed', app: plan.info.app, sourceId: row.sourceId, title: row.title, year: row.year, key: null, error: 'root_required', request, updatedAt: Date.now() };
          continue;
        }
        db.data.ledger[row.ledgerKey] = { status: 'pending', app: plan.info.app, sourceId: row.sourceId, title: row.title, year: row.year, key: null, error: null, request, updatedAt: Date.now() };
        queued++;
        continue;
      }
      // A title that is in the library already has no request. Its verification runs now, with the new facts of the source.
      const current = plan.existing.get(row.ledgerKey);
      if (!current) continue;
      applyExisting(db, current);
      requestVerification(db, enqueue, current.key, { downloads: current.downloads, episodes: current.episodes });
      verified++;
    }
    if (queued) enqueue({ type: 'migration.import', dedupeKey: 'migration.import' });
    // The plan is spent. A new preview shows what is left.
    plans.delete(req.body.planId);
    res.status(202).json({ queued, verified, ...progress(db) });
  };
}
