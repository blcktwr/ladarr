import { get } from '../../../../core/db.ts';
import type { RunView } from '@ladarr/shared/types';
import type { RequestHandler } from 'express';
import type { ImportStatus } from '../../../../library/imports/status.ts';

export function importRunGet(status: ImportStatus): RequestHandler<{ id: string }> {
  const db = get();
  return (req, res) => {
    const journal = db.data.imports[req.params.id];
    const run = status.run(req.params.id) ?? (journal ? { id: journal.id, kind: journal.kind ?? 'import', titleKey: journal.titleKey, total: journal.steps.length, done: 0, problems: [], finished: false, startedAt: journal.createdAt } : undefined);
    if (!run) return void res.status(404).json({ error: 'not_found' });
    res.json({
      run,
      steps: (journal?.steps ?? []).map((step) => {
        const copy = status.copyOfStep(run.id, step.dest);
        return { source: step.source, dest: step.dest, state: step.state, method: step.method, copiedBytes: copy?.copiedBytes ?? null, totalBytes: step.sizeBytes };
      }),
    } satisfies RunView);
  };
}
