import { randomUUID } from 'node:crypto';
import type { MigrationPreview } from '@ladarr/shared/types';
import type { MigrationStatus } from '@ladarr/shared/enums';
import type { RequestHandler } from 'express';
import type { Db } from '../../../core/db.ts';
import { buildPlan } from '../../../migration/migration.ts';
import { mapProfile, readFromApi } from '../../../migration/migration-source.ts';
import type { Tmdb } from '../../../metadata/tmdb.ts';
import { MAX_PLANS, parseConnection, parseMappings, plans, uploads } from '../../../helpers/migration.ts';

export function migrationPreview(db: Db, tmdb: Tmdb | undefined): RequestHandler {
  return async (req, res) => {
    if (!tmdb) return void res.status(503).json({ error: 'metadata_unavailable' });
    const mappings = parseMappings(req.body?.mappings);
    const backupId = typeof req.body?.backupId === 'string' ? req.body.backupId : undefined;
    // The source is a backup that the user sent, or a running instance.
    const connection = backupId ? undefined : parseConnection(req.body);
    if (!mappings || (!backupId && !connection)) return void res.status(400).json({ error: 'invalid_connection' });

    const source = backupId ? uploads.get(backupId) : await readFromApi(connection!);
    if (!source) return void res.status(404).json({ error: 'backup_not_found' });
    const plan = await buildPlan(db, tmdb, source, mappings);
    const planId = randomUUID();
    plans.set(planId, { ...plan, info: { app: source.app, version: source.version } });
    while (plans.size > MAX_PLANS) plans.delete(plans.keys().next().value!);

    const counts = { new: 0, matched: 0, conflict: 0, unmatched: 0, imported: 0, pending: 0, failed: 0, verify: 0 } satisfies Record<MigrationStatus, number> & { verify: number };
    for (const row of plan.rows) counts[row.status]++;
    // A new title is verified after the add. A title that is in the library is verified by this import alone.
    for (const ledgerKey of plan.existing.keys()) if (plan.rows.find((row) => row.ledgerKey === ledgerKey)?.status !== 'new') counts.verify++;
    const used = new Set(source.titles.map((title) => title.qualityProfileId));
    const preview: MigrationPreview = {
      planId,
      app: source.app,
      version: source.version,
      counts,
      rows: plan.rows,
      profiles: source.profiles.filter((profile) => used.has(profile.id)).map((profile) => ({ id: profile.id, name: profile.name, ...mapProfile(profile) })),
    };
    res.json(preview);
  };
}
