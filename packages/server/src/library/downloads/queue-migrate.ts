import { phaseOf, type Phase, type QueueState, type SearchOutcome } from '@ladarr/shared/queue';
import type { LegacyEntry, QueueEntry, StoredEvent } from '../../types.ts';

const WORK: readonly Phase[] = ['queued', 'searching', 'fetching', 'sending', 'downloading', 'validating', 'importing'];

const phaseOfString = (value: string | undefined): Phase => (value === 'available' ? 'available' : (WORK.find((phase) => phase === value) ?? 'queued'));

const outcomeOf = (code: string | undefined): SearchOutcome =>
  code === 'no_results' ? 'no_results' : code === 'all_rejected' ? 'all_rejected' : code === 'search_deferred' ? 'deferred' : code === 'indexers_failed' ? 'indexers_failed' : 'unspecified';

// The state that an older entry means. A null branch with a reason is a problem, and the reason stays with it.
function stateOf(stage: string | undefined, branch: string | null | undefined, reason: { code: string; detail?: string } | null | undefined): QueueState {
  const phase = phaseOfString(stage);
  if (phase === 'available') return { kind: 'available' };
  if (branch === 'cancelled') return { kind: 'cancelled', at: phase };
  if (branch === 'paused') return { kind: 'paused', resume: phase, problem: reason ?? null };
  if (branch === 'waiting') return { kind: 'waiting', outcome: outcomeOf(reason?.code) };
  if (reason) return { kind: 'blocked', at: phase as Exclude<Phase, 'available'>, problem: reason };
  return { kind: phase };
}

function migrateEntry(entry: LegacyEntry) {
  const legacy = entry.state === undefined;
  if (legacy) {
    const stage = entry.stage;
    const branch = entry.branch === 'attention' ? null : entry.branch;
    entry.state = stateOf(stage, branch, entry.reason);
    const since = entry.stageSince ?? entry.history?.at(-1)?.at ?? entry.createdAt;
    entry.stateSince = since;
    entry.phaseSince = since;
  }
  // A history event stores the state of its moment. An old event keeps the meaning that its stage and its branch give.
  for (const event of entry.history ?? []) {
    if (event.state !== undefined) continue;
    const stored = event as StoredEvent;
    const branch = stored.branch === 'attention' ? null : stored.branch;
    stored.state = stateOf(stored.stage, branch, null);
    stored.stage = phaseOf(stored.state);
    delete stored.branch;
  }
  entry.stateSince ??= entry.createdAt;
  entry.phaseSince ??= entry.stateSince;
  delete entry.stage;
  delete entry.branch;
  delete entry.reason;
  delete entry.stageSince;
}

// A pure migration of the queue data. It is idempotent, and it calls no hook, client, or webhook.
export function migrateQueue(queue: Record<string, QueueEntry>) {
  for (const entry of Object.values(queue)) migrateEntry(entry as LegacyEntry);
}
