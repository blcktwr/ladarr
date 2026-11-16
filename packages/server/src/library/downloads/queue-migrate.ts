import { phaseOf, type Phase, type QueueState, type SearchOutcome, type WorkPhase } from '@ladarr/shared/queue';
import type { LegacyEntry, QueueEntry, StoredEvent } from '../../types.ts';

const WORK: readonly Phase[] = ['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing'];

// An older version checked a download in a stage of its own. The import checks that download now, so the stage is the
// import. The value stays in an older file, and the type does not have it.
const REMOVED: Record<string, WorkPhase> = { validating: 'importing' };

const phaseOfLegacy = (value: string | undefined): Phase => {
  if (!value) return 'queued';
  if (value === 'available') return 'available';
  return REMOVED[value] ?? (WORK.find((phase) => phase === value) ?? 'queued');
};

const outcomeOf = (code: string | undefined): SearchOutcome =>
  code === 'no_results' ? 'no_results' : code === 'all_rejected' ? 'all_rejected' : code === 'search_deferred' ? 'deferred' : code === 'indexers_failed' ? 'indexers_failed' : 'unspecified';

// The phase that a saved state means now. A stage that no longer exists becomes the stage that holds its work.
function phaseOfState(state: QueueState): Phase {
  const phase = phaseOf(state);
  return REMOVED[phase as string] ?? phase;
}

function stateOfPhase(state: QueueState): QueueState {
  switch (state.kind) {
    case 'blocked': {
      const at = REMOVED[state.at as string];
      return at ? { ...state, at } : state;
    }
    case 'paused': {
      const resume = REMOVED[state.resume as string];
      return resume ? { ...state, resume } : state;
    }
    case 'cancelled': {
      const at = REMOVED[state.at as string];
      return at ? { ...state, at } : state;
    }
    default: {
      const kind = REMOVED[state.kind as string];
      return kind ? ({ kind } as QueueState) : state;
    }
  }
}

// The state that an older entry means. A null branch with a reason is a problem, and the reason stays with it.
function stateOf(stage: string | undefined, branch: string | null | undefined, reason: { code: string; detail?: string } | null | undefined): QueueState {
  const phase = phaseOfLegacy(stage);
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
  } else {
    entry.state = stateOfPhase(entry.state);
  }
  // A history event stores the state of its moment. An old event keeps the meaning that its stage and its branch give.
  for (const event of entry.history ?? []) {
    if (event.state === undefined) {
      const stored = event as StoredEvent;
      const branch = stored.branch === 'attention' ? null : stored.branch;
      stored.state = stateOf(stored.stage, branch, null);
      stored.stage = phaseOf(stored.state);
      delete stored.branch;
      continue;
    }
    event.state = stateOfPhase(event.state);
    event.stage = phaseOfState(event.state);
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
