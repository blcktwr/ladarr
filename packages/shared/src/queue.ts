// One state for each target of the queue, and one derivation of the status, the tab, and the group aggregate.
// The server, the counters, the tabs, and the web app use this module. It reads no database, clock, locale, or network.

// The journey of a target: Queued, Searching, Fetching the release, Waiting for a slot of the client, Sending to the
// client, Downloading, Importing, Available. A stage can be skipped when its work is not needed.
export type Stage = 'queued' | 'searching' | 'fetching' | 'waiting_slot' | 'sending' | 'downloading' | 'importing' | 'available';
export type Phase = Stage;
export type WorkPhase = Exclude<Stage, 'available'>;

// Why a target waits for its next search.
export type SearchOutcome = 'no_results' | 'all_rejected' | 'deferred' | 'indexers_failed' | 'unspecified';

// The problem that blocks a target. The code is stable, and the web app reads its message.
export type Problem = { code: string; detail?: string };

export type QueueState =
  | { kind: WorkPhase }
  | { kind: 'waiting'; outcome: SearchOutcome }
  | { kind: 'blocked'; at: WorkPhase; problem: Problem }
  | { kind: 'paused'; resume: Stage; problem: Problem | null }
  | { kind: 'cancelled'; at: Stage }
  | { kind: 'available' };

// What the page shows for one target. The status names a result of the work, such as a search that found nothing.
export type Status = 'queued' | 'searching' | 'fetching' | 'waiting_slot' | 'sending' | 'downloading' | 'importing' | 'available' | 'not_found' | 'no_match' | 'stuck' | 'paused' | 'cancelled';

// The tabs of the page. A target that has no tab shows in All.
export type Tab = 'queued' | 'searching' | 'downloading' | 'importing' | 'stuck';

export type Description = {
  status: Status;
  tab: Tab | null;
  phase: Phase;
  // The target is still in the queue.
  active: boolean;
  // The target can move without the user: it is not waiting, paused, or blocked.
  working: boolean;
  problem: Problem | null;
};

export type Aggregate = {
  // Null when there is no member. A group whose members are all available is available.
  status: Status | null;
  counts: Record<string, number>;
  // The tab of the aggregate status, or none when that status has no tab.
  tabs: Tab[];
  total: number;
  // The most frequent problem of the blocked members. A tie goes to the lower code.
  problem: Problem | null;
};

export const TAB_ORDER: readonly Tab[] = ['queued', 'searching', 'downloading', 'importing', 'stuck'];

// The status that a group shows, from the most urgent to the least. Stuck wins over a download, so a mixed season
// shows the problem in its row and in its inspector.
const STATUS_PRECEDENCE: readonly Status[] = ['stuck', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing', 'not_found', 'no_match', 'queued', 'paused', 'cancelled'];

const WORKING = new Set<string>(['queued', 'searching', 'fetching', 'waiting_slot', 'sending', 'downloading', 'importing']);

export function phaseOf(state: QueueState): Phase {
  switch (state.kind) {
    case 'waiting':
      return 'queued';
    case 'blocked':
      return state.at;
    case 'paused':
      return state.resume;
    case 'cancelled':
      return state.at;
    default:
      return state.kind;
  }
}

export function isActiveState(state: QueueState) {
  return state.kind !== 'available' && state.kind !== 'cancelled';
}

// The statuses that a retry takes: a target that a problem stops, and a target that waits for its next search with a
// result. Every other target is in the journey, paused, or out of the queue.
export const RETRY_STATUSES: readonly Status[] = ['stuck', 'not_found', 'no_match'];

// A retry runs the phases of the target again, so a target that waits for its next search starts it at once.
export const canRetry = (state: QueueState) => RETRY_STATUSES.includes(describe(state).status);

// A target whose pack did not hold every episode of its season. The user can search the other seasons of the releases.
// An older state keeps the cause of the pack as the detail of its attempt limit.
export const needsOtherSeasons = (state: QueueState): boolean =>
  state.kind === 'blocked' && (state.problem.code === 'pack_partial' || (state.problem.code === 'too_many_attempts' && state.problem.detail === 'pack_partial'));

export function describe(state: QueueState): Description {
  const phase = phaseOf(state);
  const active = isActiveState(state);
  if (state.kind === 'waiting') {
    // A target that waits for its next search with a result stays in Waiting with that result. A target that waits
    // for a continuation or for the indexers shows as Searching, because the work is not finished.
    const result = state.outcome === 'no_results' ? 'not_found' : state.outcome === 'all_rejected' ? 'no_match' : 'searching';
    return { status: result, tab: result === 'not_found' || result === 'no_match' ? 'queued' : 'searching', phase, active, working: false, problem: null };
  }
  if (state.kind === 'blocked') return { status: 'stuck', tab: 'stuck', phase, active, working: false, problem: state.problem };
  if (state.kind === 'paused') return { status: 'paused', tab: null, phase, active, working: false, problem: state.problem };
  if (state.kind === 'cancelled') return { status: 'cancelled', tab: null, phase, active, working: false, problem: null };
  if (state.kind === 'available') return { status: 'available', tab: null, phase, active, working: false, problem: null };
  // Sending has no tab of its own: the page shows it in All.
  return { status: state.kind, tab: state.kind === 'sending' ? null : tabOfPhase(state.kind), phase, active, working: WORKING.has(state.kind), problem: null };
}

function tabOfPhase(phase: WorkPhase): Tab {
  if (phase === 'queued') return 'queued';
  if (phase === 'searching' || phase === 'fetching') return 'searching';
  if (phase === 'waiting_slot' || phase === 'downloading') return 'downloading';
  if (phase === 'importing') return 'importing';
  return 'searching';
}

export function aggregate(states: Iterable<QueueState>): Aggregate {
  const counts: Record<string, number> = {};
  const tabs = new Map<Status, Tab | null>();
  const problems = new Map<string, { problem: Problem; count: number }>();
  let total = 0;
  let available = 0;
  const statuses = new Set<Status>();
  for (const state of states) {
    total++;
    const description = describe(state);
    counts[description.status] = (counts[description.status] ?? 0) + 1;
    tabs.set(description.status, description.tab);
    if (state.kind === 'available') available++;
    else statuses.add(description.status);
    if (state.kind === 'blocked') {
      const found = problems.get(state.problem.code);
      if (found) found.count++;
      else problems.set(state.problem.code, { problem: state.problem, count: 1 });
    }
  }
  const status = total === 0 ? null : available === total ? 'available' : (STATUS_PRECEDENCE.find((item) => statuses.has(item)) ?? null);
  let problem: Problem | null = null;
  for (const item of [...problems.values()].sort((a, b) => b.count - a.count || a.problem.code.localeCompare(b.problem.code))) {
    problem = item.problem;
    break;
  }
  const tab = status === null ? null : tabs.get(status);
  return { status, counts, tabs: tab ? [tab] : [], total, problem };
}
