import { isAbsolute } from 'node:path';
import type { MigrationProgress } from '@ladarr/shared/types';
import type { MigrationPreview } from '@ladarr/shared/types';
import type { Db } from '../core/db.ts';
import type { PathMapping, SourceData } from '../migration/migration-source.ts';
import type { Plan } from '../migration/migration.ts';

export const MAX_PLANS = 3;
export const MAX_UPLOADS = 3;
const MAX_MAPPINGS = 50;

// shortcut: plans stay in memory, so a restart drops them. The user starts the preview again.
export const plans = new Map<string, Plan & { info: Pick<MigrationPreview, 'app' | 'version'> }>();

// shortcut: a backup that the user sent stays in memory, so a restart drops it. The user sends the file again.
export const uploads = new Map<string, SourceData>();

export function progress(db: Db): MigrationProgress {
  const counts: MigrationProgress = { pending: 0, imported: 0, matched: 0, failed: 0 };
  for (const entry of Object.values(db.data.ledger)) counts[entry.status]++;
  return counts;
}

export function parseConnection(body: unknown) {
  const { url, apiKey } = (body ?? {}) as Record<string, unknown>;
  if (typeof url !== 'string' || typeof apiKey !== 'string' || !url || !apiKey || url.length > 500 || apiKey.length > 200) return;
  return { url, apiKey };
}

export function parseMappings(value: unknown): PathMapping[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MAPPINGS) return;
  const out: PathMapping[] = [];
  for (const rule of value) {
    if (typeof rule?.from !== 'string' || typeof rule?.to !== 'string' || !rule.from || rule.from.length > 500 || rule.to.length > 500 || !isAbsolute(rule.to)) return;
    out.push({ from: rule.from, to: rule.to });
  }
  return out;
}
