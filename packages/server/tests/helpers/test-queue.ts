import type { SearchOutcome, Phase, WorkPhase } from '@ladarr/shared/queue';
import type { Queue, QueueEntry } from '../../src/types.ts';

// Sets a fixture state. A change from blocked uses explicit authorization.
type Change = { stage?: string; branch?: string | null; reason?: { code: string; detail?: string } | null };

const OUTCOME: Record<string, SearchOutcome> = { no_results: 'no_results', all_rejected: 'all_rejected', search_deferred: 'deferred', indexers_failed: 'indexers_failed' };

// A queue entry for a fixture. The older fields name the state that the test arranges.
type LegacyEntry = Partial<QueueEntry> & { id: string; titleKey: string; stage?: Phase; branch?: string | null; reason?: { code: string; detail?: string } | null };

export function entryOf(input: LegacyEntry): QueueEntry {
  const { stage = 'queued', branch = null, reason = null, ...rest } = input;
  const state =
    branch === 'waiting'
      ? { kind: 'waiting' as const, outcome: OUTCOME[reason?.code ?? ''] ?? ('unspecified' as const) }
      : branch === 'paused'
        ? { kind: 'paused' as const, resume: stage, problem: reason ?? null }
        : branch === 'cancelled'
          ? { kind: 'cancelled' as const, at: stage }
          : stage === 'available'
            ? { kind: 'available' as const }
            : reason
              ? { kind: 'blocked' as const, at: stage, problem: reason }
              : { kind: stage };
  return {
    season: null,
    number: null,
    state,
    revision: 1,
    createdAt: 0,
    stateSince: 0,
    phaseSince: 0,
    completedAt: null,
    clearedAt: null,
    priority: null,
    attempt: 1,
    attempts: [],
    history: [],
    search: null,
    release: null,
    transferHash: null,
    clientId: null,
    manualMatch: null,
    importResult: null,
    ...rest,
    id: input.id,
    titleKey: input.titleKey,
  } as QueueEntry;
}

// The branch of an older test: the state that waits, pauses, or cancels.
export const branchOf = (entry: QueueEntry): 'waiting' | 'paused' | 'cancelled' | null =>
  entry.state.kind === 'waiting' || entry.state.kind === 'paused' || entry.state.kind === 'cancelled' ? entry.state.kind : null;

export function move(queue: Queue, entry: QueueEntry, change: Change, cause: string, detail?: string) {
  const outcome = change.reason ? (OUTCOME[change.reason.code] ?? 'unspecified') : 'unspecified';
  if (change.stage === 'available') {
    if (entry.state.kind === 'blocked') queue.resolve(entry, entry.state.at as WorkPhase, cause, detail);
    return queue.complete(entry, cause, detail);
  }
  if (change.stage) {
    if (entry.state.kind === 'blocked') queue.resolve(entry, change.stage as WorkPhase, cause, detail);
    else queue.enter(entry, change.stage as WorkPhase, cause, detail);
  }
  if (change.branch === 'cancelled') return queue.cancel(entry, cause);
  if (change.branch === 'paused') return queue.pause(entry, cause);
  if (change.branch === 'waiting') return queue.wait(entry, outcome, cause, detail);
  if (change.reason) queue.block(entry, { ...change.reason }, cause, detail);
  else if (change.branch === null) {
    if (entry.state.kind === 'blocked') queue.resolve(entry, entry.state.at as WorkPhase, cause, detail);
    else queue.unblock(entry, cause);
  }
  else if (!change.stage) queue.observe(entry, cause, detail);
}
